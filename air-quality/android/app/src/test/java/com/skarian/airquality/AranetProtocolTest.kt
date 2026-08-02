package com.skarian.airquality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AranetProtocolTest {
    @Test
    fun decodesAranet4AdvertisementInCanonicalUnits() {
        val bytes = ByteArray(21)
        bytes[0] = 0x20
        putU16(bytes, 8, 612)
        putU16(bytes, 10, 448)
        putU16(bytes, 12, 10086)
        bytes[14] = 46
        bytes[15] = 87
        bytes[16] = 1
        putU16(bytes, 17, 300)
        putU16(bytes, 19, 30)

        val result = AranetProtocol.parseAdvertisement(bytes, "Aranet4 06CDC", "AA:BB", 1_000)
        requireNotNull(result)
        assertEquals(970, result.observedAtEpochSeconds)
        assertEquals(612, result.co2Ppm)
        assertEquals(224, result.temperatureX10)
        assertEquals(460, result.humidityX10)
        assertEquals(10086, result.pressureX10)
        assertEquals(87, result.batteryPercent)
        assertEquals(1, result.co2State)
    }

    @Test
    fun rejectsDisabledIntegrationsAndMagicValues() {
        val disabled = ByteArray(21)
        assertNull(AranetProtocol.parseAdvertisement(disabled, "Aranet4", "AA", 1_000))

        val invalid = ByteArray(21)
        invalid[0] = 0x20
        putU16(invalid, 8, 0x8001)
        assertNull(AranetProtocol.parseAdvertisement(invalid, "Aranet4", "AA", 1_000))
    }

    @Test
    fun rejectsTruncatedPayload() {
        assertNull(AranetProtocol.parseAdvertisement(byteArrayOf(0x20), "Aranet4", "AA", 1_000))
    }

    private fun putU16(bytes: ByteArray, offset: Int, value: Int) {
        bytes[offset] = (value and 0xff).toByte()
        bytes[offset + 1] = (value ushr 8).toByte()
    }
}
