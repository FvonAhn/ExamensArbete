package com.example.mobileapp;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;

import com.example.plugins.ble.BluetoothPlugin;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.microsoft.signalr.HubConnection;
import com.microsoft.signalr.HubConnectionBuilder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.reactivex.rxjava3.core.Single;

public class AndroidBackgroundBroadcastService extends Service {
    public static final String ACTION_START = "com.example.mobileapp.background.START";
    public static final String ACTION_STOP = "com.example.mobileapp.background.STOP";
    public static final String ACTION_SYNC_METADATA = "com.example.mobileapp.background.SYNC_METADATA";
    public static final String ACTION_SYNC_FRAME = "com.example.mobileapp.background.SYNC_FRAME";

    public static final String EXTRA_DEVICE_ID = "deviceId";
    public static final String EXTRA_HUB_URL = "hubUrl";
    public static final String EXTRA_ACCESS_TOKEN = "accessToken";
    public static final String EXTRA_NOTIFICATION_TITLE = "notificationTitle";
    public static final String EXTRA_NOTIFICATION_TEXT = "notificationText";
    public static final String EXTRA_DEMO_MODE = "demoMode";
    public static final String EXTRA_METADATA_JSON = "metadataJson";
    public static final String EXTRA_VALUES_JSON = "valuesJson";
    public static final String EXTRA_POSITION_JSON = "positionJson";
    public static final String EXTRA_SOURCE_FRAME_RATE_HZ = "sourceFrameRateHz";
    public static final String EXTRA_ALLOW_NATIVE_GPS_FALLBACK = "allowNativeGpsFallback";
    public static final String EXTRA_VEHICLE_NAME = "vehicleName";
    public static final String EXTRA_VIN = "vin";

    private static final String CHANNEL_ID = "background_broadcast";
    private static final int NOTIFICATION_ID = 42042;
    private static final long FRAME_INTERVAL_MS = 1000L;
    private static final long DEMO_FRAME_INTERVAL_MS = 40L;
    private static final long RECONNECT_DELAY_MS = 3000L;
    private static final long RTT_MEASUREMENT_INTERVAL_MS = 8000L;
    private static final double RTT_EWMA_ALPHA = 0.3d;
    private static final double MAX_SOURCE_FRAME_RATE_HZ = 25.0d;
    private static final int FRAME_RATE_SAMPLE_WINDOW = 12;
    private static final int PORT_EVENTS = 3;
    private static final int EVENT_TYPE_STATE = 1;
    private static final int EVENT_TYPE_PROGRESS_VALUE = 2;
    private static final int EVENT_TYPE_PROGRESS_MESSAGE = 3;
    private static final int EVENT_TYPE_MONITORING = 4;
    private static final int EVENT_TYPE_VEHICLES_UPDATED = 6;
    private static final int EVENT_TYPE_VOLTAGE = 7;
    private static final int EVENT_TYPE_BARK = 8;
    private static final int EVENT_TYPE_PROGRESS = 9;
    private static final int EVENT_TYPE_LOG_MESSAGE = 11;

    private static volatile String currentState = "idle";
    private static volatile String lastError = null;
    private static volatile long lastFrameSentAtMs = 0L;
    private static volatile long lastLocationAtMs = 0L;
    private static volatile long lastMonitoringValueAtMs = 0L;
    private static volatile AndroidBackgroundBroadcastService instance = null;
    private static volatile boolean appVisible = true;

    private final Object dataLock = new Object();
    private final Object monitoringBufferLock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final List<Byte> monitoringBuffer = new ArrayList<>();
    private final BluetoothPlugin.RawDataListener rawBleDataListener = new BluetoothPlugin.RawDataListener() {
        @Override
        public void onData(int port, byte[] content) {
            if (!serviceStarted || port != PORT_EVENTS) {
                return;
            }

            handleMonitoringPayload(content);
        }

        @Override
        public void onDisconnected() {
            clearMonitoringBuffer();
        }
    };

    private final Runnable framePump = new Runnable() {
        @Override
        public void run() {
            if (!serviceStarted) {
                return;
            }
            worker.execute(() -> {
                try {
                    sendLatestFrame();
                } catch (Exception ex) {
                    setState("disconnected", ex.getMessage());
                }
            });
            mainHandler.postDelayed(this, getFrameIntervalMs());
        }
    };

    private final Runnable reconnectRunnable = this::connectHubIfNeeded;
    private final Runnable rttRunnable = new Runnable() {
        @Override
        public void run() {
            if (!serviceStarted) {
                return;
            }
            worker.execute(() -> {
                try {
                    measureAndReportRtt();
                } catch (Exception ignored) {
                    // Keep RTT reporting best-effort.
                }
            });
            mainHandler.postDelayed(this, RTT_MEASUREMENT_INTERVAL_MS);
        }
    };

    private FusedLocationProviderClient fusedLocationClient;
    private LocationCallback locationCallback;
    private HubConnection hubConnection;
    private volatile boolean hubConnected = false;
    private volatile boolean serviceStarted = false;
    private volatile boolean stopping = false;

    private String deviceId = "";
    private String hubUrl = "";
    private String accessToken = "";
    private String notificationTitle = "Background broadcast active";
    private String notificationText = "Streaming telemetry";
    private String vehicleName = null;
    private String vin = null;
    private boolean demoMode = false;
    private boolean allowNativeGpsFallback = false;
    private final AndroidBackgroundDemoTelemetryGenerator demoTelemetryGenerator =
        new AndroidBackgroundDemoTelemetryGenerator();

    private List<TelemetryParameterMetaDto> latestMetadata = new ArrayList<>();
    private final Map<String, TelemetryValueDto> latestTelemetryValuesByKey = new LinkedHashMap<>();
    private final Map<Integer, String> telemetryKeyByLogId = new LinkedHashMap<>();
    private PositionDto latestNativePosition = null;
    private PositionDto latestJsPosition = null;
    private long latestNativePositionAtMs = 0L;
    private long latestJsPositionAtMs = 0L;
    private long previousFrameSentAtMs = 0L;
    private long previousMonitoringEventAtMs = 0L;
    private final ArrayList<Double> recentFrameRates = new ArrayList<>();
    private final ArrayList<Double> recentMonitoringEventRates = new ArrayList<>();
    private final Object frameRateLock = new Object();
    private Double smoothedRttMs = null;
    private Double latestSourceFrameRateHz = null;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);
        createNotificationChannel();
        initLocationCallback();
        BluetoothPlugin.registerRawDataListener(rawBleDataListener);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_NOT_STICKY;
        }

        switch (intent.getAction()) {
            case ACTION_START:
                handleStart(intent);
                break;
            case ACTION_STOP:
                handleStop();
                break;
            case ACTION_SYNC_METADATA:
                handleSyncMetadata(intent);
                break;
            case ACTION_SYNC_FRAME:
                handleSyncFrame(intent);
                break;
            default:
                break;
        }

        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        serviceStarted = false;
        stopping = true;
        mainHandler.removeCallbacks(framePump);
        mainHandler.removeCallbacks(rttRunnable);
        mainHandler.removeCallbacks(reconnectRunnable);
        stopLocationUpdates();
        disconnectHub();
        BluetoothPlugin.setBackgroundBroadcastActive(false);
        BluetoothPlugin.unregisterRawDataListener(rawBleDataListener);
        clearMonitoringBuffer();
        worker.shutdownNow();
        lastMonitoringValueAtMs = 0L;
        currentState = "idle";
        lastError = null;
        BackgroundBroadcastPlugin.emitStateChanged(
            currentState,
            lastError,
            lastFrameSentAtMs,
            lastLocationAtMs,
            lastMonitoringValueAtMs
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        cancelNotification();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        handleStop();
        super.onTaskRemoved(rootIntent);
    }

    private void handleStart(Intent intent) {
        stopping = false;
        BluetoothPlugin.setBackgroundBroadcastActive(true);
        deviceId = safeString(intent.getStringExtra(EXTRA_DEVICE_ID));
        hubUrl = safeString(intent.getStringExtra(EXTRA_HUB_URL));
        accessToken = safeString(intent.getStringExtra(EXTRA_ACCESS_TOKEN));
        notificationTitle = safeString(intent.getStringExtra(EXTRA_NOTIFICATION_TITLE), notificationTitle);
        notificationText = safeString(intent.getStringExtra(EXTRA_NOTIFICATION_TEXT), notificationText);
        demoMode = intent.getBooleanExtra(EXTRA_DEMO_MODE, false);
        clearMonitoringBuffer();
        synchronized (dataLock) {
            latestMetadata = new ArrayList<>();
            latestTelemetryValuesByKey.clear();
            telemetryKeyByLogId.clear();
            latestJsPosition = null;
            latestNativePosition = null;
            latestJsPositionAtMs = 0L;
            latestNativePositionAtMs = 0L;
        }
        allowNativeGpsFallback = false;
        lastFrameSentAtMs = 0L;
        lastLocationAtMs = 0L;
        lastMonitoringValueAtMs = 0L;
        previousFrameSentAtMs = 0L;
        previousMonitoringEventAtMs = 0L;
        smoothedRttMs = null;
        latestSourceFrameRateHz = null;
        synchronized (frameRateLock) {
            recentFrameRates.clear();
            recentMonitoringEventRates.clear();
        }

        serviceStarted = true;
        updateForegroundNotification();
        setState("connecting", null);

        startLocationUpdates();
        mainHandler.removeCallbacks(framePump);
        mainHandler.post(framePump);
        mainHandler.removeCallbacks(rttRunnable);
        mainHandler.post(rttRunnable);

        worker.execute(this::connectHubIfNeeded);
    }

    private void handleStop() {
        stopping = true;
        serviceStarted = false;
        mainHandler.removeCallbacks(framePump);
        mainHandler.removeCallbacks(rttRunnable);
        mainHandler.removeCallbacks(reconnectRunnable);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        cancelNotification();
        stopSelf();
    }

    private void handleSyncMetadata(Intent intent) {
        if (stopping || !serviceStarted) {
            return;
        }
        vehicleName = intent.getStringExtra(EXTRA_VEHICLE_NAME);
        vin = intent.getStringExtra(EXTRA_VIN);

        String metadataJson = safeString(intent.getStringExtra(EXTRA_METADATA_JSON), "[]");
        synchronized (dataLock) {
            latestMetadata = parseMetadata(metadataJson);
            rebuildTelemetryKeyByLogIdLocked();
            pruneTelemetryValuesToMetadataLocked();
        }

        if (hubConnected) {
            worker.execute(this::sendMetadataFrame);
        }
    }

    private void handleSyncFrame(Intent intent) {
        if (stopping || !serviceStarted) {
            return;
        }
        String valuesJson = safeString(intent.getStringExtra(EXTRA_VALUES_JSON), "[]");
        String positionJson = safeString(intent.getStringExtra(EXTRA_POSITION_JSON), "{}");
        Double sourceFrameRateHz =
            intent.hasExtra(EXTRA_SOURCE_FRAME_RATE_HZ)
                ? intent.getDoubleExtra(EXTRA_SOURCE_FRAME_RATE_HZ, 0.0d)
                : null;
        boolean nextAllowNativeGpsFallback =
            intent.getBooleanExtra(EXTRA_ALLOW_NATIVE_GPS_FALLBACK, false);

        synchronized (dataLock) {
            if (!demoMode) {
                mergeTelemetryValuesLocked(parseTelemetryValues(valuesJson));
                latestJsPosition = parsePosition(positionJson);
                latestJsPositionAtMs = latestJsPosition != null ? System.currentTimeMillis() : 0L;
                allowNativeGpsFallback = nextAllowNativeGpsFallback;
                if (sourceFrameRateHz != null
                    && Double.isFinite(sourceFrameRateHz)
                    && sourceFrameRateHz > 0.0d) {
                    latestSourceFrameRateHz = sourceFrameRateHz;
                }
            }
        }

    }

    private void connectHubIfNeeded() {
        if (!serviceStarted || deviceId.isEmpty() || hubUrl.isEmpty()) {
            return;
        }
        if (hubConnection != null && hubConnected) {
            return;
        }

        disconnectHub();
        setState("connecting", null);

        try {
            HubConnection connection = HubConnectionBuilder.create(hubUrl)
                .withAccessTokenProvider(Single.defer(() -> Single.just(accessToken)))
                .build();

            connection.onClosed(error -> {
                hubConnected = false;
                setState("disconnected", error != null ? error.getMessage() : null);
                scheduleReconnect();
            });

            connection.start().blockingAwait();
            connection.send("JoinDeviceGroup", deviceId);

            hubConnection = connection;
            hubConnected = true;
            setState("connected", null);
            sendMetadataFrame();
            sendLatestFrame();
        } catch (Exception ex) {
            hubConnected = false;
            setState("disconnected", ex.getMessage());
            scheduleReconnect();
        }
    }

    private void disconnectHub() {
        HubConnection connection = hubConnection;
        hubConnection = null;
        hubConnected = false;
        if (connection == null) {
            return;
        }

        try {
            connection.send("StopTelemetryStream", deviceId);
        } catch (Exception ignored) {
            // Keep cleanup best-effort in the experimental service.
        }

        try {
            connection.stop().blockingAwait();
        } catch (Exception ignored) {
            // Keep cleanup best-effort in the experimental service.
        }
    }

    private void scheduleReconnect() {
        mainHandler.removeCallbacks(reconnectRunnable);
        if (!serviceStarted) {
            return;
        }
        setState("reconnecting", lastError);
        mainHandler.postDelayed(reconnectRunnable, RECONNECT_DELAY_MS);
    }

    private void sendMetadataFrame() {
        HubConnection connection = hubConnection;
        if (connection == null || !hubConnected) {
            return;
        }

        TelemetryMetaFrameDto frame = new TelemetryMetaFrameDto();
        frame.deviceId = deviceId;
        frame.parameters = snapshotMetadata();
        frame.vehicleName = vehicleName;
        frame.vin = vin;

        try {
            connection.send("SendTelemetryMeta", frame);
        } catch (Exception ex) {
            setState("disconnected", ex.getMessage());
            scheduleReconnect();
        }
    }

    private void sendLatestFrame() {
        HubConnection connection = hubConnection;
        if (connection == null || !hubConnected) {
            return;
        }

        if (demoMode) {
            synchronized (dataLock) {
                updateDemoTelemetryValuesLocked();
            }
        }

        TelemetryFrameDto frame = new TelemetryFrameDto();
        frame.deviceId = deviceId;
        frame.timestamp = System.currentTimeMillis();
        frame.values = snapshotTelemetryValues();
        frame.framerateStr = buildFrameRateString();
        frame.position = snapshotMergedPosition();

        try {
            connection.send("SendTelemetryFrame", frame);
            long sentAtMs = System.currentTimeMillis();
            recordFrameSent(sentAtMs);
            BackgroundBroadcastPlugin.emitStateChanged(
                currentState,
                lastError,
                lastFrameSentAtMs,
                lastLocationAtMs,
                lastMonitoringValueAtMs
            );
        } catch (Exception ex) {
            setState("disconnected", ex.getMessage());
            scheduleReconnect();
        }
    }

    private long getFrameIntervalMs() {
        return demoMode ? DEMO_FRAME_INTERVAL_MS : FRAME_INTERVAL_MS;
    }

    private String buildFrameRateString() {
        if (demoMode) {
            return buildMeasuredOrFallbackFrameRateString();
        }

        synchronized (frameRateLock) {
            if (!recentMonitoringEventRates.isEmpty()) {
                return buildMonitoringEventRateStringLocked();
            }
        }

        if (latestSourceFrameRateHz != null && Double.isFinite(latestSourceFrameRateHz) && latestSourceFrameRateHz > 0.0d) {
            return String.format(java.util.Locale.US, "%.2f", latestSourceFrameRateHz);
        }

        return buildMeasuredOrFallbackFrameRateString();
    }

    private String buildMonitoringEventRateStringLocked() {
        double sum = 0.0d;
        for (double rate : recentMonitoringEventRates) {
            sum += rate;
        }
        double average = Math.min(sum / recentMonitoringEventRates.size(), MAX_SOURCE_FRAME_RATE_HZ);
        return String.format(java.util.Locale.US, "%.2f", average);
    }

    private String buildMeasuredOrFallbackFrameRateString() {
        synchronized (frameRateLock) {
            if (recentFrameRates.isEmpty()) {
                double fallbackHz = 1000.0d / Math.max(1L, getFrameIntervalMs());
                return String.format(java.util.Locale.US, "%.2f", fallbackHz);
            }

            double sum = 0.0d;
            for (double rate : recentFrameRates) {
                sum += rate;
            }
            double average = sum / recentFrameRates.size();
            return String.format(java.util.Locale.US, "%.2f", average);
        }
    }

    private void recordFrameSent(long sentAtMs) {
        synchronized (frameRateLock) {
            if (previousFrameSentAtMs > 0L && sentAtMs > previousFrameSentAtMs) {
                double frameRate = 1000.0d / (sentAtMs - previousFrameSentAtMs);
                recentFrameRates.add(frameRate);
                if (recentFrameRates.size() > FRAME_RATE_SAMPLE_WINDOW) {
                    recentFrameRates.remove(0);
                }
            }

            previousFrameSentAtMs = sentAtMs;
        }
        lastFrameSentAtMs = sentAtMs;
    }

    private void recordMonitoringEvent(long eventAtMs) {
        synchronized (frameRateLock) {
            if (previousMonitoringEventAtMs > 0L && eventAtMs > previousMonitoringEventAtMs) {
                double eventRate = 1000.0d / (eventAtMs - previousMonitoringEventAtMs);
                recentMonitoringEventRates.add(eventRate);
                if (recentMonitoringEventRates.size() > FRAME_RATE_SAMPLE_WINDOW) {
                    recentMonitoringEventRates.remove(0);
                }
            }

            previousMonitoringEventAtMs = eventAtMs;
        }
    }

    private void measureAndReportRtt() {
        HubConnection connection = hubConnection;
        if (connection == null || !hubConnected) {
            return;
        }

        try {
            long sentAtMs = System.currentTimeMillis();
            connection.invoke(Long.class, "Ping", sentAtMs).blockingGet();
            long receivedAtMs = System.currentTimeMillis();
            double rttSample = Math.max(0L, receivedAtMs - sentAtMs);
            smoothedRttMs =
                smoothedRttMs == null
                    ? rttSample
                    : smoothedRttMs + (RTT_EWMA_ALPHA * (rttSample - smoothedRttMs));
            int stableRtt = (int) Math.round(smoothedRttMs);
            connection.invoke("ReportRtt", stableRtt).blockingAwait();
        } catch (Exception ignored) {
            // Keep RTT reporting best-effort in the experimental service.
        }
    }

    private List<TelemetryParameterMetaDto> snapshotMetadata() {
        synchronized (dataLock) {
            return new ArrayList<>(latestMetadata);
        }
    }

    private List<TelemetryValueDto> snapshotTelemetryValues() {
        synchronized (dataLock) {
            return new ArrayList<>(latestTelemetryValuesByKey.values());
        }
    }

    private PositionDto snapshotMergedPosition() {
        synchronized (dataLock) {
            if (!allowNativeGpsFallback) {
                return latestJsPosition;
            }
            return mergePosition(latestNativePosition, latestJsPosition);
        }
    }

    private PositionDto mergePosition(PositionDto nativePosition, PositionDto jsPosition) {
        if (nativePosition == null && jsPosition == null) {
            return null;
        }

        if (nativePosition != null && jsPosition != null) {
            long newestTimestamp = Math.max(latestNativePositionAtMs, latestJsPositionAtMs);
            long oldestTimestamp = Math.min(latestNativePositionAtMs, latestJsPositionAtMs);

            // When the JS-side stops syncing after backgrounding, prefer fresh native GPS.
            if (newestTimestamp - oldestTimestamp > 2000L) {
                return latestNativePositionAtMs >= latestJsPositionAtMs ? nativePosition : jsPosition;
            }
        }

        PositionDto merged = new PositionDto();
        PositionDto preferred =
            latestNativePositionAtMs >= latestJsPositionAtMs
                ? (nativePosition != null ? nativePosition : jsPosition)
                : (jsPosition != null ? jsPosition : nativePosition);
        PositionDto fallback = preferred == nativePosition ? jsPosition : nativePosition;

        merged.latitude = firstNumber(preferred != null ? preferred.latitude : null, fallback != null ? fallback.latitude : null);
        merged.longitude = firstNumber(preferred != null ? preferred.longitude : null, fallback != null ? fallback.longitude : null);
        merged.accuracy = firstNumber(preferred != null ? preferred.accuracy : null, fallback != null ? fallback.accuracy : null);
        merged.speed = firstNumber(preferred != null ? preferred.speed : null, fallback != null ? fallback.speed : null);
        merged.heading = firstNumber(preferred != null ? preferred.heading : null, fallback != null ? fallback.heading : null);
        merged.altitude = firstNumber(preferred != null ? preferred.altitude : null, fallback != null ? fallback.altitude : null);
        merged.altitudeAccuracy = firstNumber(preferred != null ? preferred.altitudeAccuracy : null, fallback != null ? fallback.altitudeAccuracy : null);
        return merged;
    }

    private Double firstNumber(Double primary, Double fallback) {
        return primary != null ? primary : fallback;
    }

    private void startLocationUpdates() {
        boolean fineGranted =
            ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;

        if (!fineGranted) {
            setState("disconnected", "Missing ACCESS_FINE_LOCATION permission");
            return;
        }

        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L)
            .setMinUpdateIntervalMillis(500L)
            .setWaitForAccurateLocation(false)
            .build();

        fusedLocationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper());
    }

    private void stopLocationUpdates() {
        if (fusedLocationClient != null && locationCallback != null) {
            fusedLocationClient.removeLocationUpdates(locationCallback);
        }
    }

    private void initLocationCallback() {
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                Location location = result.getLastLocation();
                if (location == null) {
                    return;
                }

                PositionDto position = new PositionDto();
                position.latitude = location.getLatitude();
                position.longitude = location.getLongitude();
                position.accuracy = location.hasAccuracy() ? (double) location.getAccuracy() : null;
                position.speed = location.hasSpeed() ? (double) location.getSpeed() : null;
                position.heading = location.hasBearing() ? (double) location.getBearing() : null;
                position.altitude = location.hasAltitude() ? location.getAltitude() : null;
                position.altitudeAccuracy = null;

                synchronized (dataLock) {
                    latestNativePosition = position;
                    latestNativePositionAtMs = System.currentTimeMillis();
                }

                lastLocationAtMs = System.currentTimeMillis();
                BackgroundBroadcastPlugin.emitStateChanged(
                    currentState,
                    lastError,
                    lastFrameSentAtMs,
                    lastLocationAtMs,
                    lastMonitoringValueAtMs
                );

                if (hubConnected) {
                    worker.execute(AndroidBackgroundBroadcastService.this::sendLatestFrame);
                }
            }
        };
    }

    private Notification buildNotification(String stateLabel) {
        Intent intent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = null;
        if (intent != null) {
            pendingIntent = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(notificationTitle)
            .setContentText(notificationText + " - " + stateLabel)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(pendingIntent)
            .build();
    }

    private void updateNotification() {
        if (appVisible) {
            return;
        }
        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager == null) {
            return;
        }
        notificationManager.notify(NOTIFICATION_ID, buildNotification(currentStateLabel()));
    }

    private void cancelNotification() {
        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager == null) {
            return;
        }
        notificationManager.cancel(NOTIFICATION_ID);
    }

    private void updateForegroundNotification() {
        if (!serviceStarted) {
            return;
        }

        if (appVisible) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            cancelNotification();
            return;
        }

        startForeground(NOTIFICATION_ID, buildNotification(currentStateLabel()));
    }

    private String currentStateLabel() {
        String state = currentState;
        if (lastError != null && !lastError.isEmpty()) {
            return state + " (" + lastError + ")";
        }
        return state;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Background broadcast",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Foreground service for telemetry and GPS broadcast");

        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager != null) {
            notificationManager.createNotificationChannel(channel);
        }
    }

    private void setState(String state, String error) {
        currentState = state;
        lastError = error;
        BackgroundBroadcastPlugin.emitStateChanged(
            state,
            error,
            lastFrameSentAtMs,
            lastLocationAtMs,
            lastMonitoringValueAtMs
        );
        updateNotification();
    }

    public static void setAppVisible(boolean visible) {
        appVisible = visible;

        AndroidBackgroundBroadcastService service = instance;
        if (service == null) {
            return;
        }

        service.mainHandler.post(service::updateForegroundNotification);
    }

    private void mergeTelemetryValuesLocked(List<TelemetryValueDto> values) {
        for (TelemetryValueDto value : values) {
            if (value == null || value.key == null || value.key.isEmpty()) {
                continue;
            }
            latestTelemetryValuesByKey.put(value.key, value);
        }
    }

    private void rebuildTelemetryKeyByLogIdLocked() {
        telemetryKeyByLogId.clear();
        for (TelemetryParameterMetaDto meta : latestMetadata) {
            if (meta == null || meta.logId == null || meta.key == null || meta.key.isEmpty()) {
                continue;
            }
            telemetryKeyByLogId.put(meta.logId, meta.key);
        }
    }

    private void pruneTelemetryValuesToMetadataLocked() {
        Map<String, Boolean> allowedKeys = new LinkedHashMap<>();
        for (TelemetryParameterMetaDto meta : latestMetadata) {
            if (meta != null && meta.key != null && !meta.key.isEmpty()) {
                allowedKeys.put(meta.key, true);
            }
        }
        latestTelemetryValuesByKey.entrySet().removeIf((entry) -> !allowedKeys.containsKey(entry.getKey()));
    }

    private void handleMonitoringPayload(byte[] payload) {
        synchronized (monitoringBufferLock) {
            for (byte value : payload) {
                monitoringBuffer.add(value);
            }
            parseMonitoringBufferLocked();
        }
    }

    private void clearMonitoringBuffer() {
        synchronized (monitoringBufferLock) {
            monitoringBuffer.clear();
        }
    }

    private void parseMonitoringBufferLocked() {
        if (monitoringBuffer.isEmpty()) {
            return;
        }

        byte[] bytes = new byte[monitoringBuffer.size()];
        for (int i = 0; i < monitoringBuffer.size(); i++) {
            bytes[i] = monitoringBuffer.get(i);
        }

        int consumed = 0;
        while (consumed < bytes.length) {
            ParseOutcome outcome = tryParseEvent(bytes, consumed);
            if (outcome.status == ParseStatus.INCOMPLETE) {
                break;
            }

            if (outcome.status == ParseStatus.INVALID) {
                monitoringBuffer.clear();
                return;
            }

            consumed += outcome.bytesConsumed;
        }

        if (consumed > 0) {
            monitoringBuffer.subList(0, consumed).clear();
        }
    }

    private ParseOutcome tryParseEvent(byte[] bytes, int offset) {
        BufferCursor cursor = new BufferCursor(bytes, offset);
        Integer eventType = cursor.readUInt8();
        if (eventType == null) {
            return ParseOutcome.incomplete();
        }

        switch (eventType) {
            case EVENT_TYPE_STATE:
                return ParseOutcome.complete(cursor.consumed(offset));
            case EVENT_TYPE_PROGRESS_VALUE:
                if (!skipUInt8StringStringUInt16(cursor)) {
                    return ParseOutcome.incomplete();
                }
                return ParseOutcome.complete(cursor.consumed(offset));
            case EVENT_TYPE_PROGRESS_MESSAGE:
                if (!skipUInt8StringString(cursor)) {
                    return ParseOutcome.incomplete();
                }
                return ParseOutcome.complete(cursor.consumed(offset));
            case EVENT_TYPE_MONITORING: {
                List<MonitoringValue> values = readMonitoringValues(cursor);
                if (values == null) {
                    return ParseOutcome.incomplete();
                }
                applyMonitoringValues(values);
                return ParseOutcome.complete(cursor.consumed(offset));
            }
            case EVENT_TYPE_VEHICLES_UPDATED:
                if (!skipVehicleArray(cursor)) {
                    return ParseOutcome.incomplete();
                }
                return ParseOutcome.complete(cursor.consumed(offset));
            case EVENT_TYPE_VOLTAGE:
            case EVENT_TYPE_PROGRESS:
                if (cursor.readUInt8() == null) {
                    return ParseOutcome.incomplete();
                }
                return ParseOutcome.complete(cursor.consumed(offset));
            case EVENT_TYPE_BARK:
                if (cursor.readUInt32() == null) {
                    return ParseOutcome.incomplete();
                }
                return ParseOutcome.complete(cursor.consumed(offset));
            case EVENT_TYPE_LOG_MESSAGE:
                if (cursor.readString() == null || cursor.readByteArray() == null) {
                    return ParseOutcome.incomplete();
                }
                return ParseOutcome.complete(cursor.consumed(offset));
            default:
                return ParseOutcome.invalid();
        }
    }

    private boolean skipUInt8StringStringUInt16(BufferCursor cursor) {
        return cursor.readUInt8() != null
            && cursor.readString() != null
            && cursor.readString() != null
            && cursor.readUInt16() != null;
    }

    private boolean skipUInt8StringString(BufferCursor cursor) {
        return cursor.readUInt8() != null
            && cursor.readString() != null
            && cursor.readString() != null;
    }

    private List<MonitoringValue> readMonitoringValues(BufferCursor cursor) {
        Integer count = cursor.readUInt16();
        if (count == null) {
            return null;
        }

        List<MonitoringValue> values = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            Integer logId = cursor.readUInt8();
            String value = cursor.readString();
            if (logId == null || value == null) {
                return null;
            }
            values.add(new MonitoringValue(logId, value));
        }
        return values;
    }

    private boolean skipVehicleArray(BufferCursor cursor) {
        Integer count = cursor.readUInt16();
        if (count == null) {
            return false;
        }

        for (int i = 0; i < count; i++) {
            if (cursor.readString() == null
                || cursor.readString() == null
                || cursor.readUInt8() == null
                || cursor.readString() == null
                || cursor.readUInt8() == null
                || cursor.readUInt8() == null
                || cursor.readUInt8() == null
                || cursor.readUInt8() == null
                || cursor.readString() == null) {
                return false;
            }
        }

        return true;
    }

    private void applyMonitoringValues(List<MonitoringValue> monitoringValues) {
        long now = System.currentTimeMillis();
        boolean updated = false;

        synchronized (dataLock) {
            for (MonitoringValue monitoringValue : monitoringValues) {
                String key = telemetryKeyByLogId.get(monitoringValue.logId);
                if (key == null || key.isEmpty()) {
                    continue;
                }

                double numericValue;
                try {
                    numericValue = Double.parseDouble(monitoringValue.value);
                } catch (NumberFormatException ignored) {
                    continue;
                }

                TelemetryValueDto dto = new TelemetryValueDto();
                dto.key = key;
                dto.value = numericValue;
                latestTelemetryValuesByKey.put(key, dto);
                updated = true;
            }
        }

        if (!updated) {
            return;
        }

        recordMonitoringEvent(now);
        lastMonitoringValueAtMs = now;
        BackgroundBroadcastPlugin.emitStateChanged(
            currentState,
            lastError,
            lastFrameSentAtMs,
            lastLocationAtMs,
            lastMonitoringValueAtMs
        );

        if (hubConnected) {
            worker.execute(this::sendLatestFrame);
        }
    }

    private void updateDemoTelemetryValuesLocked() {
        long now = System.currentTimeMillis();
        boolean updated = demoTelemetryGenerator.updateValues(latestMetadata, latestTelemetryValuesByKey);

        if (updated) {
            lastMonitoringValueAtMs = now;
        }
    }

    private List<TelemetryParameterMetaDto> parseMetadata(String metadataJson) {
        List<TelemetryParameterMetaDto> values = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(metadataJson);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                TelemetryParameterMetaDto dto = new TelemetryParameterMetaDto();
                dto.key = item.optString("key", "");
                dto.name = item.optString("name", "");
                dto.unit = item.optString("unit", "");
                dto.module = item.optString("module", "");
                dto.min = item.optDouble("min", 0);
                dto.max = item.optDouble("max", 0);
                dto.logId = item.has("logId") && !item.isNull("logId") ? item.optInt("logId") : null;
                values.add(dto);
            }
        } catch (Exception ex) {
            setState("disconnected", ex.getMessage());
        }
        return values;
    }

    private List<TelemetryValueDto> parseTelemetryValues(String valuesJson) {
        List<TelemetryValueDto> values = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(valuesJson);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                if (!item.has("value") || item.isNull("value")) {
                    continue;
                }
                TelemetryValueDto dto = new TelemetryValueDto();
                dto.key = item.optString("key", "");
                dto.value = item.optDouble("value", 0);
                values.add(dto);
            }
        } catch (Exception ex) {
            setState("disconnected", ex.getMessage());
        }
        return values;
    }

    private PositionDto parsePosition(String positionJson) {
        try {
            JSONObject item = new JSONObject(positionJson);
            if (item.length() == 0) {
                return null;
            }

            PositionDto dto = new PositionDto();
            dto.latitude = readNullableDouble(item, "latitude");
            dto.longitude = readNullableDouble(item, "longitude");
            dto.accuracy = readNullableDouble(item, "accuracy");
            dto.speed = readNullableDouble(item, "speed");
            dto.heading = readNullableDouble(item, "heading");
            dto.altitude = readNullableDouble(item, "altitude");
            dto.altitudeAccuracy = readNullableDouble(item, "altitudeAccuracy");
            return dto;
        } catch (Exception ex) {
            setState("disconnected", ex.getMessage());
            return null;
        }
    }

    private Double readNullableDouble(JSONObject item, String key) {
        if (!item.has(key) || item.isNull(key)) {
            return null;
        }
        return item.optDouble(key);
    }

    private String safeString(String value) {
        return value == null ? "" : value;
    }

    private String safeString(String value, String fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        return value;
    }

    public static String getCurrentState() {
        return currentState;
    }

    public static String getLastError() {
        return lastError;
    }

    public static long getLastFrameSentAtMs() {
        return lastFrameSentAtMs;
    }

    public static long getLastLocationAtMs() {
        return lastLocationAtMs;
    }

    public static long getLastMonitoringValueAtMs() {
        return lastMonitoringValueAtMs;
    }

    public static boolean isAppVisible() {
        return appVisible;
    }

    public static class TelemetryValueDto {
        public String key;
        public double value;
    }

    public static class PositionDto {
        public Double latitude;
        public Double longitude;
        public Double accuracy;
        public Double speed;
        public Double heading;
        public Double altitude;
        public Double altitudeAccuracy;
    }

    public static class TelemetryFrameDto {
        public String deviceId;
        public long timestamp;
        public List<TelemetryValueDto> values;
        public String framerateStr;
        public PositionDto position;
    }

    public static class TelemetryParameterMetaDto {
        public String key;
        public String name;
        public String unit;
        public String module;
        public double min;
        public double max;
        public Integer logId;
    }

    public static class TelemetryMetaFrameDto {
        public String deviceId;
        public List<TelemetryParameterMetaDto> parameters;
        public String vehicleName;
        public String vin;
    }

    private static class MonitoringValue {
        final int logId;
        final String value;

        MonitoringValue(int logId, String value) {
            this.logId = logId;
            this.value = value;
        }
    }

    private enum ParseStatus {
        COMPLETE,
        INCOMPLETE,
        INVALID
    }

    private static class ParseOutcome {
        final ParseStatus status;
        final int bytesConsumed;

        ParseOutcome(ParseStatus status, int bytesConsumed) {
            this.status = status;
            this.bytesConsumed = bytesConsumed;
        }

        static ParseOutcome complete(int bytesConsumed) {
            return new ParseOutcome(ParseStatus.COMPLETE, bytesConsumed);
        }

        static ParseOutcome incomplete() {
            return new ParseOutcome(ParseStatus.INCOMPLETE, 0);
        }

        static ParseOutcome invalid() {
            return new ParseOutcome(ParseStatus.INVALID, 0);
        }
    }

    private static class BufferCursor {
        private final byte[] bytes;
        private int position;

        BufferCursor(byte[] bytes, int offset) {
            this.bytes = bytes;
            this.position = offset;
        }

        Integer readUInt8() {
            if (position >= bytes.length) {
                return null;
            }
            return bytes[position++] & 0xFF;
        }

        Integer readUInt16() {
            Integer low = readUInt8();
            Integer high = readUInt8();
            if (low == null || high == null) {
                return null;
            }
            return low | (high << 8);
        }

        Long readUInt32() {
            Integer low = readUInt16();
            Integer high = readUInt16();
            if (low == null || high == null) {
                return null;
            }
            return (long) low | ((long) high << 16);
        }

        byte[] readByteArray() {
            Integer length = readUInt16();
            if (length == null) {
                return null;
            }
            if (position + length > bytes.length) {
                return null;
            }
            byte[] result = new byte[length];
            System.arraycopy(bytes, position, result, 0, length);
            position += length;
            return result;
        }

        String readString() {
            byte[] data = readByteArray();
            if (data == null) {
                return null;
            }
            return new String(data, StandardCharsets.UTF_8);
        }

        int consumed(int offset) {
            return position - offset;
        }
    }
}
