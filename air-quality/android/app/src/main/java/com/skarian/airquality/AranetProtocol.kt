package com.skarian.airquality

/**
 * Read-only Aranet4 advertisement decoding.
 *
 * The byte layout is adapted from Anrijs Jargans' MIT-licensed Aranet4-Python
 * project: https://github.com/Anrijs/Aranet4-Python . Aranet documents the
 * advertised service UUID change but does not publish the measurement payload.
 */
object AranetProtocol {
    const val MANUFACTURER_ID = 0x0702
    const val SERVICE_CURRENT = "0000fce0-0000-1000-8000-00805f9b34fb"
    const val SERVICE_LEGACY = "f0cd1400-95da-4f4b-9ac8-aa55d312af0c"

    fun parseAdvertisement(
        manufacturerData: ByteArray,
        deviceName: String?,
        address: String,
        receivedAtEpochSeconds: Long,
    ): AranetReading? {
        val source = if (deviceName?.startsWith("Aranet4") == true ||
            manufacturerData.size == 7 || manufacturerData.size == 22
        ) {
            byteArrayOf(0) + manufacturerData
        } else {
            manufacturerData
        }
        if (source.size < 22 || source[0].toInt() != 0) return null

        val flags = u8(source, 1)
        val integrationsEnabled = flags and (1 shl 5) != 0
        if (!integrationsEnabled) return null

        val co2Raw = u16(source, 9)
        val temperatureRaw = u16(source, 11)
        val pressureRaw = u16(source, 13)
        val humidityRaw = u8(source, 15)
        val battery = u8(source, 16)
        val state = u8(source, 17)
        val ageSeconds = u16(source, 20)

        if (co2Raw and 0x8000 != 0 || pressureRaw and 0x8000 != 0 ||
            temperatureRaw and 0x4000 != 0 || humidityRaw !in 0..100 ||
            battery !in 0..100 || state !in 0..3
        ) return null

        return AranetReading(
            address = address,
            deviceName = deviceName?.takeIf { it.isNotBlank() } ?: "Aranet4",
            observedAtEpochSeconds = (receivedAtEpochSeconds - ageSeconds).coerceAtLeast(0),
            co2Ppm = co2Raw,
            temperatureX10 = (temperatureRaw + 1) / 2,
            humidityX10 = humidityRaw * 10,
            pressureX10 = pressureRaw,
            batteryPercent = battery,
            co2State = state,
        )
    }

    fun parseDetailedCurrent(
        value: ByteArray,
        deviceName: String,
        address: String,
        receivedAtEpochSeconds: Long,
    ): AranetReading? {
        if (value.size < 13) return null
        val co2Raw = u16(value, 0)
        val temperatureRaw = u16(value, 2)
        val pressureRaw = u16(value, 4)
        val humidityRaw = u8(value, 6)
        val battery = u8(value, 7)
        val state = u8(value, 8)
        val ageSeconds = u16(value, 11)
        if (co2Raw and 0x8000 != 0 || pressureRaw and 0x8000 != 0 ||
            temperatureRaw and 0x4000 != 0 || humidityRaw !in 0..100 ||
            battery !in 0..100 || state !in 0..3
        ) return null
        return AranetReading(
            address, deviceName, (receivedAtEpochSeconds - ageSeconds).coerceAtLeast(0),
            co2Raw, (temperatureRaw + 1) / 2, humidityRaw * 10, pressureRaw,
            battery, state,
        )
    }

    private fun u8(bytes: ByteArray, offset: Int): Int = bytes[offset].toInt() and 0xff
    private fun u16(bytes: ByteArray, offset: Int): Int =
        u8(bytes, offset) or (u8(bytes, offset + 1) shl 8)
}
