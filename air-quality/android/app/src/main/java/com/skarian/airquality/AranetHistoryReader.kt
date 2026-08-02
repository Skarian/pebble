package com.skarian.airquality

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.time.Instant
import java.util.UUID

@SuppressLint("MissingPermission")
class AranetHistoryReader(private val context: Context) {
    fun import(
        address: String,
        deviceName: String,
        batteryPercent: Int,
        co2State: Int,
        complete: (Result<List<AranetReading>>) -> Unit,
    ) {
        Session(context, address, deviceName, batteryPercent, co2State, complete).start()
    }

    private class Session(
        private val context: Context,
        private val address: String,
        private val deviceName: String,
        private val batteryPercent: Int,
        private val co2State: Int,
        private val complete: (Result<List<AranetReading>>) -> Unit,
    ) : BluetoothGattCallback() {
        private val handler = Handler(Looper.getMainLooper())
        private var gatt: BluetoothGatt? = null
        private var finished = false
        private var state = State.CONNECTING
        private var totalReadings = 0
        private var intervalSeconds = 0
        private var requestedStart = 1
        private var sampleCount = 0
        private var parameterIndex = 0
        private var newestAgeSeconds = 0
        private var newestTotal = 0
        private lateinit var command: BluetoothGattCharacteristic
        private lateinit var history: BluetoothGattCharacteristic
        private lateinit var total: BluetoothGattCharacteristic
        private lateinit var interval: BluetoothGattCharacteristic
        private val values = mutableMapOf<Int, IntArray>()
        private val timeout = Runnable { fail("Bluetooth history timed out") }

        fun start() {
            val manager = context.getSystemService(BluetoothManager::class.java)
            val device = runCatching { manager.adapter.getRemoteDevice(address) }.getOrNull()
            if (device == null) { fail("Aranet4 is unavailable"); return }
            armTimeout()
            gatt = device.connectGatt(context, false, this, BluetoothDevice.TRANSPORT_LE)
        }

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS || newState != BluetoothProfile.STATE_CONNECTED) {
                fail("Could not connect to Aranet4 history")
                return
            }
            this.gatt = gatt
            gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            state = State.MTU
            armTimeout()
            if (!gatt.requestMtu(247)) discoverServices(gatt)
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) = discoverServices(gatt)

        private fun discoverServices(gatt: BluetoothGatt) {
            state = State.SERVICES
            armTimeout()
            if (!gatt.discoverServices()) fail("Could not read Aranet4 services")
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("Could not read Aranet4 services"); return }
            fun characteristic(value: String): BluetoothGattCharacteristic? = gatt.services.asSequence()
                .flatMap { it.characteristics.asSequence() }
                .firstOrNull { it.uuid == UUID.fromString(value) }
            command = characteristic(UUID_COMMAND) ?: run { fail("Aranet4 history is unavailable"); return }
            history = characteristic(UUID_HISTORY_V2) ?: run { fail("Aranet4 history format is unavailable"); return }
            total = characteristic(UUID_TOTAL) ?: run { fail("Aranet4 history count is unavailable"); return }
            interval = characteristic(UUID_INTERVAL) ?: run { fail("Aranet4 history interval is unavailable"); return }
            state = State.TOTAL
            read(total)
        }

        @Deprecated("Used on Android 12 and earlier")
        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) = handleRead(characteristic, characteristic.value ?: byteArrayOf(), status)

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) = handleRead(characteristic, value, status)

        private fun handleRead(characteristic: BluetoothGattCharacteristic, bytes: ByteArray, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) { fail("Could not read Aranet4 history"); return }
            when (state) {
                State.TOTAL -> {
                    totalReadings = u16(bytes)
                    if (totalReadings <= 0) { fail("Aranet4 has no saved history"); return }
                    state = State.INTERVAL
                    read(interval)
                }
                State.INTERVAL -> {
                    intervalSeconds = u16(bytes)
                    if (intervalSeconds <= 0) { fail("Aranet4 history interval is invalid"); return }
                    val wanted = (RETENTION_SECONDS / intervalSeconds + 2).toInt()
                    sampleCount = minOf(totalReadings, wanted)
                    requestedStart = totalReadings - sampleCount + 1
                    AranetHistoryProtocol.PARAMETERS.forEach {
                        values[it] = IntArray(sampleCount) { UNAVAILABLE }
                    }
                    requestParameter()
                }
                State.HISTORY -> handlePacket(bytes)
                else -> Unit
            }
        }

        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            if (state != State.COMMAND || status != BluetoothGatt.GATT_SUCCESS) {
                fail("Could not request Aranet4 history")
                return
            }
            state = State.HISTORY
            read(history)
        }

        private fun handlePacket(bytes: ByteArray) {
            val packet = AranetHistoryProtocol.parse(bytes)
                ?: run { fail("Aranet4 returned invalid history"); return }
            val expected = AranetHistoryProtocol.PARAMETERS[parameterIndex]
            if (packet.parameter != expected) { fail("Aranet4 returned mismatched history"); return }
            intervalSeconds = packet.intervalSeconds.takeIf { it > 0 } ?: intervalSeconds
            newestAgeSeconds = packet.newestAgeSeconds
            newestTotal = packet.totalReadings
            val target = values.getValue(expected)
            packet.values.forEachIndexed { index, raw ->
                val offset = packet.startIndex + index - requestedStart
                if (offset in target.indices) target[offset] = AranetHistoryProtocol.decode(expected, raw) ?: UNAVAILABLE
            }
            if (packet.startIndex + packet.values.size - 1 >= totalReadings) {
                parameterIndex += 1
                if (parameterIndex >= AranetHistoryProtocol.PARAMETERS.size) finishReadings()
                else requestParameter()
            } else {
                read(history)
            }
        }

        private fun requestParameter() {
            state = State.COMMAND
            val bytes = AranetHistoryProtocol.request(
                AranetHistoryProtocol.PARAMETERS[parameterIndex], requestedStart,
            )
            armTimeout()
            val started = if (Build.VERSION.SDK_INT >= 33) {
                gatt?.writeCharacteristic(command, bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) ==
                    BluetoothStatusCodes.SUCCESS
            } else {
                command.value = bytes
                command.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                gatt?.writeCharacteristic(command) == true
            }
            if (!started) fail("Could not request Aranet4 history")
        }

        private fun read(characteristic: BluetoothGattCharacteristic) {
            armTimeout()
            if (gatt?.readCharacteristic(characteristic) != true) fail("Could not read Aranet4 history")
        }

        private fun finishReadings() {
            val total = newestTotal.takeIf { it > 0 } ?: totalReadings
            val newestAt = Instant.now().epochSecond - newestAgeSeconds
            val temperature = values.getValue(AranetHistoryProtocol.PARAM_TEMPERATURE)
            val humidity = values.getValue(AranetHistoryProtocol.PARAM_HUMIDITY)
            val pressure = values.getValue(AranetHistoryProtocol.PARAM_PRESSURE)
            val co2 = values.getValue(AranetHistoryProtocol.PARAM_CO2)
            val readings = (0 until sampleCount).mapNotNull { offset ->
                if (temperature[offset] == UNAVAILABLE || humidity[offset] == UNAVAILABLE ||
                    pressure[offset] == UNAVAILABLE || co2[offset] == UNAVAILABLE
                ) return@mapNotNull null
                val oneBasedIndex = requestedStart + offset
                AranetReading(
                    address = address,
                    deviceName = deviceName,
                    observedAtEpochSeconds = newestAt - (total - oneBasedIndex).toLong() * intervalSeconds,
                    co2Ppm = co2[offset],
                    temperatureX10 = temperature[offset],
                    humidityX10 = humidity[offset],
                    pressureX10 = pressure[offset],
                    batteryPercent = batteryPercent,
                    co2State = co2State,
                )
            }
            if (readings.isEmpty()) fail("Aranet4 history contains no usable readings")
            else succeed(readings)
        }

        private fun armTimeout() {
            handler.removeCallbacks(timeout)
            handler.postDelayed(timeout, OPERATION_TIMEOUT_MS)
        }

        private fun succeed(readings: List<AranetReading>) = finish(Result.success(readings))
        private fun fail(message: String) = finish(Result.failure(IllegalStateException(message)))

        private fun finish(result: Result<List<AranetReading>>) {
            if (finished) return
            finished = true
            handler.removeCallbacks(timeout)
            runCatching { gatt?.disconnect() }
            runCatching { gatt?.close() }
            handler.post { complete(result) }
        }

        private fun u16(bytes: ByteArray): Int = if (bytes.size < 2) 0 else
            (bytes[0].toInt() and 0xff) or ((bytes[1].toInt() and 0xff) shl 8)

        private enum class State { CONNECTING, MTU, SERVICES, TOTAL, INTERVAL, COMMAND, HISTORY }

        companion object {
            private const val UUID_COMMAND = "f0cd1402-95da-4f4b-9ac8-aa55d312af0c"
            private const val UUID_TOTAL = "f0cd2001-95da-4f4b-9ac8-aa55d312af0c"
            private const val UUID_INTERVAL = "f0cd2002-95da-4f4b-9ac8-aa55d312af0c"
            private const val UUID_HISTORY_V2 = "f0cd2005-95da-4f4b-9ac8-aa55d312af0c"
            private const val RETENTION_SECONDS = 8L * 24 * 60 * 60
            private const val OPERATION_TIMEOUT_MS = 15_000L
        }
    }
}
