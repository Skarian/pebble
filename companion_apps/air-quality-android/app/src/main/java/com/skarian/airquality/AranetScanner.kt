package com.skarian.airquality

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import com.skarian.pebble.errors.ErrorReporter
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class DiscoveredAranet(
    val address: String,
    val name: String,
    val reading: AranetReading?,
)

class AranetScanner(
    private val context: Context,
    private val errors: ErrorReporter = ErrorReporter.Disabled,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private val adapter: BluetoothAdapter? get() = bluetoothManager?.adapter

    fun bluetoothEnabled(): Boolean = adapter?.isEnabled == true

    fun hasPermissions(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }

    @SuppressLint("MissingPermission")
    fun discover(durationMillis: Long = 6000, complete: (List<DiscoveredAranet>) -> Unit) {
        val scanner = adapter?.bluetoothLeScanner ?: run {
            errors.report(BluetoothScannerUnavailable(), "discovering Aranet sensors")
            complete(emptyList())
            return
        }
        val found = linkedMapOf<String, DiscoveredAranet>()
        var finished = false
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                try {
                    val name = result.device.name ?: result.scanRecord?.deviceName ?: "Aranet4"
                    if (!name.startsWith("Aranet4") && !hasAranetService(result)) return
                    val bytes = result.scanRecord?.getManufacturerSpecificData(AranetProtocol.MANUFACTURER_ID)
                    val reading = bytes?.let {
                        AranetProtocol.parseAdvertisement(
                            it, name, result.device.address, Instant.now().epochSecond,
                        )
                    }
                    found[result.device.address] = DiscoveredAranet(result.device.address, name, reading)
                } catch (error: Throwable) {
                    errors.report(error, "processing an Aranet discovery result")
                    finish()
                }
            }

            override fun onScanFailed(errorCode: Int) {
                errors.report(bluetoothScanFailure(errorCode), "discovering Aranet sensors")
                finish()
            }

            fun finish() {
                if (finished) return
                finished = true
                runCatching { scanner.stopScan(this) }
                complete(found.values.toList())
            }
        }
        try {
            scanner.startScan(serviceFilters(), scanSettings(ScanSettings.SCAN_MODE_LOW_LATENCY), callback)
        } catch (error: Throwable) {
            errors.report(error, "starting Aranet discovery")
            callback.finish()
        }
        handler.postDelayed({ callback.finish() }, durationMillis)
    }

    @SuppressLint("MissingPermission")
    fun readOnce(
        address: String,
        timeoutMillis: Long = 15000,
        complete: (AranetReading?) -> Unit,
    ): () -> Unit {
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null) {
            errors.report(BluetoothScannerUnavailable(), "reading the Aranet sensor")
            complete(null)
            return {}
        }
        val finished = AtomicBoolean()
        var timeout: Runnable? = null
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                try {
                    val bytes = result.scanRecord?.getManufacturerSpecificData(AranetProtocol.MANUFACTURER_ID) ?: return
                    val name = result.device.name ?: result.scanRecord?.deviceName ?: "Aranet4"
                    val reading = AranetProtocol.parseAdvertisement(
                        bytes, name, result.device.address, Instant.now().epochSecond,
                    ) ?: return
                    finish(reading)
                } catch (error: Throwable) {
                    errors.report(error, "processing an Aranet scan result")
                    finish(null)
                }
            }

            override fun onScanFailed(errorCode: Int) {
                errors.report(bluetoothScanFailure(errorCode), "reading the Aranet sensor")
                finish(null)
            }

            fun finish(reading: AranetReading?, deliver: Boolean = true) {
                if (!finished.compareAndSet(false, true)) return
                timeout?.let(handler::removeCallbacks)
                runCatching { scanner.stopScan(this) }
                if (deliver) complete(reading)
            }
        }
        try {
            val filter = ScanFilter.Builder().setDeviceAddress(address).build()
            scanner.startScan(listOf(filter), scanSettings(ScanSettings.SCAN_MODE_LOW_LATENCY), callback)
        } catch (error: Throwable) {
            errors.report(error, "starting the Aranet scan")
            callback.finish(null)
        }
        val timeoutTask = Runnable {
            if (!finished.get()) errors.report(
                bluetoothScanTimeout(timeoutMillis), "reading the Aranet sensor",
            )
            callback.finish(null)
        }
        timeout = timeoutTask
        handler.postDelayed(timeoutTask, timeoutMillis)
        return { callback.finish(null, deliver = false) }
    }

    private fun serviceFilters(): List<ScanFilter> = listOf(
        ScanFilter.Builder().setServiceUuid(ParcelUuid(UUID.fromString(AranetProtocol.SERVICE_CURRENT))).build(),
        ScanFilter.Builder().setServiceUuid(ParcelUuid(UUID.fromString(AranetProtocol.SERVICE_LEGACY))).build(),
    )

    private fun scanSettings(mode: Int): ScanSettings = ScanSettings.Builder()
        .setScanMode(mode)
        .setReportDelay(0)
        .build()

    private fun hasAranetService(result: ScanResult): Boolean {
        val services = result.scanRecord?.serviceUuids.orEmpty().map { it.uuid.toString().lowercase() }
        return AranetProtocol.SERVICE_CURRENT in services || AranetProtocol.SERVICE_LEGACY in services
    }

}

internal class BluetoothScannerUnavailable :
    IllegalStateException("Android did not provide a Bluetooth LE scanner.")

internal fun bluetoothScanFailure(errorCode: Int) = mapOf(
    "name" to "BluetoothScanFailure", "message" to "Bluetooth LE scan failed.", "errorCode" to errorCode,
)
internal fun bluetoothScanTimeout(timeoutMillis: Long) = mapOf(
    "name" to "BluetoothScanTimeout", "message" to "Bluetooth LE scan timed out.", "timeoutMillis" to timeoutMillis,
)
