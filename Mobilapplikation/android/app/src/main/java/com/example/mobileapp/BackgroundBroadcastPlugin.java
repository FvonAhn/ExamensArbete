package com.example.mobileapp;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundBroadcast")
public class BackgroundBroadcastPlugin extends Plugin {
    private static volatile BackgroundBroadcastPlugin instance;

    @Override
    public void load() {
        super.load();
        instance = this;
        emitStateChanged(
            AndroidBackgroundBroadcastService.getCurrentState(),
            AndroidBackgroundBroadcastService.getLastError(),
            AndroidBackgroundBroadcastService.getLastFrameSentAtMs(),
            AndroidBackgroundBroadcastService.getLastLocationAtMs(),
            AndroidBackgroundBroadcastService.getLastMonitoringValueAtMs()
        );
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), AndroidBackgroundBroadcastService.class);
        intent.setAction(AndroidBackgroundBroadcastService.ACTION_START);
        intent.putExtra(AndroidBackgroundBroadcastService.EXTRA_DEVICE_ID, call.getString("deviceId", ""));
        intent.putExtra(AndroidBackgroundBroadcastService.EXTRA_HUB_URL, call.getString("hubUrl", ""));
        intent.putExtra(AndroidBackgroundBroadcastService.EXTRA_ACCESS_TOKEN, call.getString("accessToken", ""));
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_NOTIFICATION_TITLE,
            call.getString("notificationTitle", "Background broadcast active")
        );
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_NOTIFICATION_TEXT,
            call.getString("notificationText", "Streaming telemetry")
        );
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_DEMO_MODE,
            call.getBoolean("demoMode", false)
        );
        if (AndroidBackgroundBroadcastService.isAppVisible()) {
            getContext().startService(intent);
        } else {
            ContextCompat.startForegroundService(getContext(), intent);
        }
        call.resolve(buildStateObject());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), AndroidBackgroundBroadcastService.class);
        intent.setAction(AndroidBackgroundBroadcastService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve(buildStateObject());
    }

    @PluginMethod
    public void syncMetadata(PluginCall call) {
        Intent intent = new Intent(getContext(), AndroidBackgroundBroadcastService.class);
        intent.setAction(AndroidBackgroundBroadcastService.ACTION_SYNC_METADATA);
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_METADATA_JSON,
            call.getString("metadataJson", "[]")
        );
        intent.putExtra(AndroidBackgroundBroadcastService.EXTRA_VEHICLE_NAME, call.getString("vehicleName"));
        intent.putExtra(AndroidBackgroundBroadcastService.EXTRA_VIN, call.getString("vin"));
        getContext().startService(intent);
        call.resolve(buildStateObject());
    }

    @PluginMethod
    public void syncFrame(PluginCall call) {
        Intent intent = new Intent(getContext(), AndroidBackgroundBroadcastService.class);
        intent.setAction(AndroidBackgroundBroadcastService.ACTION_SYNC_FRAME);
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_VALUES_JSON,
            call.getString("valuesJson", "[]")
        );
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_POSITION_JSON,
            call.getString("positionJson", "{}")
        );
        if (call.hasOption("sourceFrameRateHz")) {
            Double frameRateHz = call.getDouble("sourceFrameRateHz");
            if (frameRateHz != null) {
                intent.putExtra(AndroidBackgroundBroadcastService.EXTRA_SOURCE_FRAME_RATE_HZ, frameRateHz);
            }
        }
        intent.putExtra(
            AndroidBackgroundBroadcastService.EXTRA_ALLOW_NATIVE_GPS_FALLBACK,
            call.getBoolean("allowNativeGpsFallback", false)
        );
        getContext().startService(intent);
        call.resolve(buildStateObject());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(buildStateObject());
    }

    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        call.resolve(buildPermissionObject());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null)
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    private JSObject buildStateObject() {
        JSObject data = new JSObject();
        data.put("state", AndroidBackgroundBroadcastService.getCurrentState());
        data.put("lastError", AndroidBackgroundBroadcastService.getLastError());
        data.put("lastFrameSentAtMs", AndroidBackgroundBroadcastService.getLastFrameSentAtMs());
        data.put("lastLocationAtMs", AndroidBackgroundBroadcastService.getLastLocationAtMs());
        data.put("lastMonitoringValueAtMs", AndroidBackgroundBroadcastService.getLastMonitoringValueAtMs());
        return data;
    }

    private JSObject buildPermissionObject() {
        JSObject data = new JSObject();
        boolean fineGranted = ContextCompat.checkSelfPermission(
            getContext(),
            android.Manifest.permission.ACCESS_FINE_LOCATION
        )
            == android.content.pm.PackageManager.PERMISSION_GRANTED;
        boolean backgroundGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(
                getContext(),
                android.Manifest.permission.ACCESS_BACKGROUND_LOCATION
            )
            == android.content.pm.PackageManager.PERMISSION_GRANTED;
        boolean notificationsGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || NotificationManagerCompat.from(getContext()).areNotificationsEnabled();

        data.put("fineLocationGranted", fineGranted);
        data.put("backgroundLocationGranted", backgroundGranted);
        data.put("notificationsGranted", notificationsGranted);
        return data;
    }

    static void emitStateChanged(
        String state,
        String lastError,
        long lastFrameSentAtMs,
        long lastLocationAtMs,
        long lastMonitoringValueAtMs
    ) {
        BackgroundBroadcastPlugin plugin = instance;
        if (plugin == null) {
            return;
        }

        JSObject data = new JSObject();
        data.put("state", state);
        data.put("lastError", lastError);
        data.put("lastFrameSentAtMs", lastFrameSentAtMs);
        data.put("lastLocationAtMs", lastLocationAtMs);
        data.put("lastMonitoringValueAtMs", lastMonitoringValueAtMs);
        plugin.notifyListeners("stateChanged", data, true);
    }
}
