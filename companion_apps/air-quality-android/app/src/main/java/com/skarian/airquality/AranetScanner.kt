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
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

data class DiscoveredAranet(
    val address: String,
    val name: String,
    val reading: AranetReading?,
)

class AranetScanner(private val context: Context) {
    private val handler = Handler(Looper.getMainLooper())
    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private val adapter: BluetoothAdapter? get() = bluetoothManager?.adapter

    fun bluetoothEnabled(): Boolean = adapter?.isEnabled == true

    fun hasPermissions(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    @SuppressLint("MissingPermission")
    fun discover(durationMillis: Long = 6000, complete: (List<DiscoveredAranet>) -> Unit) {
        val scanner = adapter?.bluetoothLeScanner ?: run { complete(emptyList()); return }
        val found = linkedMapOf<String, DiscoveredAranet>()
        var finished = false
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val name = result.device.name ?: result.scanRecord?.deviceName ?: "Aranet4"
                if (!name.startsWith("Aranet4") && !hasAranetService(result)) return
                val bytes = result.scanRecord?.getManufacturerSpecificData(AranetProtocol.MANUFACTURER_ID)
                val reading = bytes?.let {
                    AranetProtocol.parseAdvertisement(
                        it, name, result.device.address, Instant.now().epochSecond,
                    )
                }
                found[result.device.address] = DiscoveredAranet(result.device.address, name, reading)
            }

            override fun onScanFailed(errorCode: Int) { finish() }

            fun finish() {
                if (finished) return
                finished = true
                runCatching { scanner.stopScan(this) }
                complete(found.values.toList())
            }
        }
        scanner.startScan(serviceFilters(), scanSettings(ScanSettings.SCAN_MODE_LOW_LATENCY), callback)
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
            complete(null)
            return {}
        }
        val finished = AtomicBoolean()
        var timeout: Runnable? = null
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val bytes = result.scanRecord?.getManufacturerSpecificData(AranetProtocol.MANUFACTURER_ID) ?: return
                val name = result.device.name ?: result.scanRecord?.deviceName ?: "Aranet4"
                val reading = AranetProtocol.parseAdvertisement(
                    bytes, name, result.device.address, Instant.now().epochSecond,
                ) ?: return
                finish(reading)
            }

            override fun onScanFailed(errorCode: Int) { finish(null) }

            fun finish(reading: AranetReading?, deliver: Boolean = true) {
                if (!finished.compareAndSet(false, true)) return
                timeout?.let(handler::removeCallbacks)
                runCatching { scanner.stopScan(this) }
                if (deliver) complete(reading)
            }
        }
        val filter = ScanFilter.Builder().setDeviceAddress(address).build()
        scanner.startScan(listOf(filter), scanSettings(ScanSettings.SCAN_MODE_LOW_LATENCY), callback)
        val timeoutTask = Runnable { callback.finish(null) }
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
