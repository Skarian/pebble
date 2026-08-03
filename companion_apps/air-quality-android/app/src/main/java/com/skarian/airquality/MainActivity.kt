package com.skarian.airquality

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import java.time.Instant
import kotlin.math.abs

@SuppressLint("SetTextI18n")
class MainActivity : Activity() {
    private lateinit var settings: CompanionSettings
    private lateinit var sensorStatus: TextView
    private lateinit var watchName: EditText
    private lateinit var currentReading: TextView
    private lateinit var detailReading: TextView
    private lateinit var serviceStatus: TextView
    private var historyImporting = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settings = CompanionSettings(this)
        sensorStatus = findViewById(R.id.sensorStatus)
        watchName = findViewById(R.id.watchName)
        currentReading = findViewById(R.id.currentReading)
        detailReading = findViewById(R.id.detailReading)
        serviceStatus = findViewById(R.id.serviceStatus)
        watchName.setText(settings.watchName)

        findViewById<Button>(R.id.chooseSensor).setOnClickListener { chooseSensor() }
        findViewById<Button>(R.id.refreshNow).setOnClickListener { refreshNow() }
        AirQualityDailySync.schedule(this)
        updateUi()
        maybeImportHistory()
    }

    override fun onResume() {
        super.onResume()
        updateUi()
        maybeImportHistory()
    }

    override fun onPause() {
        settings.watchName = watchName.text.toString()
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQUEST_BLUETOOTH -> {
                if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                    discoverSensors()
                } else {
                    serviceStatus.text = "Allow Nearby devices to find your Aranet4."
                }
            }
        }
    }

    private fun chooseSensor() {
        if (!AranetScanner(this).hasPermissions()) {
            requestPermissions(requiredPermissions(), REQUEST_BLUETOOTH)
            return
        }
        discoverSensors()
    }

    private fun discoverSensors() {
        val scanner = AranetScanner(this)
        if (!scanner.bluetoothEnabled()) {
            serviceStatus.text = "Turn on Bluetooth, then try again."
            return
        }
        serviceStatus.text = "Looking for Aranet4..."
        scanner.discover { devices ->
            if (devices.isEmpty()) {
                serviceStatus.text = "No Aranet4 found. Keep it nearby and try again."
                return@discover
            }
            val labels = devices.map { device ->
                val reading = device.reading?.let { " · ${it.co2Ppm} ppm" } ?: ""
                device.name + reading
            }.toTypedArray()
            AlertDialog.Builder(this)
                .setTitle("Choose Aranet4")
                .setItems(labels) { _, index -> selectSensor(devices[index]) }
                .setNegativeButton("Cancel", null)
                .show()
        }
    }

    private fun selectSensor(device: DiscoveredAranet) {
        settings.sensorAddress = device.address
        settings.sensorName = device.name
        settings.historyImportedAddress = null
        settings.historyAttemptedAddress = null
        device.reading?.let { reading -> ReadingStore(this).use { it.save(reading) } }
        AirQualityDailySync.schedule(this)
        updateUi()
        maybeImportHistory(force = true)
    }

    private fun refreshNow() {
        settings.watchName = watchName.text.toString()
        val address = settings.sensorAddress
        if (address.isNullOrBlank()) {
            chooseSensor()
            return
        }
        val scanner = AranetScanner(this)
        if (!scanner.hasPermissions()) {
            requestPermissions(requiredPermissions(), REQUEST_BLUETOOTH)
            return
        }
        if (!scanner.bluetoothEnabled()) {
            serviceStatus.text = "Turn on Bluetooth, then try again."
            return
        }
        serviceStatus.text = "Refreshing..."
        scanner.readOnce(address) { reading ->
            if (reading == null) serviceStatus.text = "Sensor not found. Keep it nearby and try again."
            else {
                ReadingStore(this).use { it.save(reading) }
                if (settings.historyImportedAddress == address) {
                    updateUi()
                } else {
                    settings.historyAttemptedAddress = null
                    maybeImportHistory(force = true)
                }
            }
        }
    }

    private fun maybeImportHistory(force: Boolean = false) {
        val address = settings.sensorAddress ?: return
        if (historyImporting || settings.historyImportedAddress == address) return
        if (!force && settings.historyAttemptedAddress == address) return
        val scanner = AranetScanner(this)
        if (!scanner.hasPermissions() || !scanner.bluetoothEnabled()) return
        val now = Instant.now().epochSecond
        val current = ReadingStore(this).use {
            it.snapshot(address, settings.watchName, now, ChartScale.HOUR)?.current
        } ?: return

        historyImporting = true
        settings.historyAttemptedAddress = address
        serviceStatus.text = "Importing saved Aranet4 history..."
        AranetHistoryReader(applicationContext).import(
            address = address,
            deviceName = settings.sensorName ?: "Aranet4",
            batteryPercent = current.batteryPercent,
            co2State = current.co2State,
        ) { result ->
            historyImporting = false
            val message = result.fold(
                onSuccess = { readings ->
                    ReadingStore(this).use { it.saveAll(readings) }
                    settings.historyImportedAddress = address
                    Log.i(HISTORY_LOG_TAG, "Imported ${readings.size} saved readings")
                    "Imported ${readings.size} saved readings."
                },
                onFailure = { error ->
                    Log.w(HISTORY_LOG_TAG, "Saved history import failed: ${error.message}")
                    "Saved history unavailable. New readings will still be saved."
                },
            )
            updateUi()
            serviceStatus.text = message
        }
    }

    private fun updateUi() {
        val address = settings.sensorAddress
        sensorStatus.text = if (address.isNullOrBlank()) "No sensor selected" else settings.sensorName ?: "Aranet4"
        if (address.isNullOrBlank()) {
            currentReading.text = "No reading yet"
            detailReading.text = "Choose your Aranet4 to begin."
            serviceStatus.text = "Daily sync starts after you choose a sensor."
            return
        }
        val now = Instant.now().epochSecond
        val snapshot = ReadingStore(this).use {
            it.snapshot(address, settings.watchName, now, ChartScale.HOUR)
        }
        if (snapshot == null) {
            currentReading.text = "No reading yet"
            detailReading.text = "Tap Refresh now."
        } else {
            val value = snapshot.current
            currentReading.text = "${value.co2Ppm} ppm"
            detailReading.text = String.format(
                "%.1f F · %.0f%% · %.1f hPa · %s",
                value.temperatureX10 * 0.18 + 32.0,
                value.humidityX10 / 10.0,
                value.pressureX10 / 10.0,
                age(now - value.observedAtEpochSeconds),
            )
        }
        val lastDailySync = settings.lastDailySyncSuccessAt
        serviceStatus.text = if (lastDailySync > 0) {
            "Daily sync enabled · Last daily sync ${age(now - lastDailySync)}."
        } else {
            "Daily sync enabled · First automatic sync pending."
        }
    }

    private fun requiredPermissions(): Array<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun age(seconds: Long): String {
        val safe = abs(seconds)
        return when {
            safe < 60 -> "just now"
            safe < 3600 -> "${safe / 60}m ago"
            safe < 86400 -> "${safe / 3600}h ago"
            else -> "${safe / 86400}d ago"
        }
    }

    companion object {
        private const val HISTORY_LOG_TAG = "AirQualityHistory"
        private const val REQUEST_BLUETOOTH = 200
    }
}
