package com.skarian.airquality

data class AranetHistoryPacket(
    val parameter: Int,
    val intervalSeconds: Int,
    val totalReadings: Int,
    val newestAgeSeconds: Int,
    val startIndex: Int,
    val values: List<Int>,
)

object AranetHistoryProtocol {
    const val PARAM_TEMPERATURE = 1
    const val PARAM_HUMIDITY = 2
    const val PARAM_PRESSURE = 3
    const val PARAM_CO2 = 4
    val PARAMETERS = intArrayOf(PARAM_TEMPERATURE, PARAM_HUMIDITY, PARAM_PRESSURE, PARAM_CO2)

    fun request(parameter: Int, startIndex: Int): ByteArray = byteArrayOf(
        0x61,
        parameter.toByte(),
        (startIndex and 0xff).toByte(),
        (startIndex ushr 8).toByte(),
    )

    fun parse(bytes: ByteArray): AranetHistoryPacket? {
        if (bytes.size < 10) return null
        val parameter = u8(bytes, 0)
        val count = u8(bytes, 9)
        val valueSize = if (parameter == PARAM_HUMIDITY) 1 else 2
        if (parameter !in PARAMETERS || count == 0 || bytes.size < 10 + count * valueSize) return null
        val values = (0 until count).map { index ->
            val offset = 10 + index * valueSize
            if (valueSize == 1) u8(bytes, offset) else u16(bytes, offset)
        }
        return AranetHistoryPacket(
            parameter = parameter,
            intervalSeconds = u16(bytes, 1),
            totalReadings = u16(bytes, 3),
            newestAgeSeconds = u16(bytes, 5),
            startIndex = u16(bytes, 7),
            values = values,
        )
    }

    fun decode(parameter: Int, raw: Int): Int? = when (parameter) {
        PARAM_CO2 -> raw.takeIf { it and 0x8000 == 0 }
        PARAM_TEMPERATURE -> raw.takeIf { it and 0x4000 == 0 }?.let { (it + 1) / 2 }
        PARAM_HUMIDITY -> raw.takeIf { it in 0..100 }?.let { it * 10 }
        PARAM_PRESSURE -> raw.takeIf { it and 0x8000 == 0 }
        else -> null
    }

    private fun u8(bytes: ByteArray, offset: Int): Int = bytes[offset].toInt() and 0xff
    private fun u16(bytes: ByteArray, offset: Int): Int =
        u8(bytes, offset) or (u8(bytes, offset + 1) shl 8)
}
