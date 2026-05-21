package com.example.mobileapp;

import java.util.List;
import java.util.Map;
import java.util.Random;

class AndroidBackgroundDemoTelemetryGenerator {
    private final Random random = new Random();

    public boolean updateValues(
        List<AndroidBackgroundBroadcastService.TelemetryParameterMetaDto> metadata,
        Map<String, AndroidBackgroundBroadcastService.TelemetryValueDto> telemetryValuesByKey
    ) {
        boolean updated = false;

        for (AndroidBackgroundBroadcastService.TelemetryParameterMetaDto meta : metadata) {
            if (meta == null || meta.key == null || meta.key.isEmpty() || meta.logId == null) {
                continue;
            }

            double min = meta.min;
            double max = meta.max;

            if (!Double.isFinite(min) || !Double.isFinite(max) || max <= min) {
                min = 0.0;
                max = 100.0;
            }

            AndroidBackgroundBroadcastService.TelemetryValueDto existingValue =
                telemetryValuesByKey.get(meta.key);
            double nextValue = existingValue != null ? existingValue.value : midpoint(min, max);

            if (random.nextBoolean()) {
                double changePercent = random.nextBoolean() ? 1.0 : -1.0;
                nextValue = clamp((nextValue * (100.0 + changePercent)) / 100.0, min, max);
            }

            AndroidBackgroundBroadcastService.TelemetryValueDto dto =
                new AndroidBackgroundBroadcastService.TelemetryValueDto();
            dto.key = meta.key;
            dto.value = nextValue;
            telemetryValuesByKey.put(dto.key, dto);
            updated = true;
        }

        return updated;
    }

    private double midpoint(double min, double max) {
        return min + ((max - min) / 2.0);
    }

    private double clamp(double value, double min, double max) {
        return Math.max(min, Math.min(max, value));
    }
}
