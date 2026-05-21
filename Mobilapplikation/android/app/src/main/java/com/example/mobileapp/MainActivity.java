package com.example.mobileapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.example.plugins.ble.BluetoothPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundBroadcastPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        BluetoothPlugin.setAppVisible(true);
        AndroidBackgroundBroadcastService.setAppVisible(true);
    }

    @Override
    public void onPause() {
        BluetoothPlugin.setAppVisible(false);
        AndroidBackgroundBroadcastService.setAppVisible(false);
        super.onPause();
    }
}
