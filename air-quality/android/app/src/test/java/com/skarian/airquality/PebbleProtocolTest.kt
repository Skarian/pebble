package com.skarian.airquality

import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class PebbleProtocolTest {
    @Test
    fun emitsMatchingFourMetricDictionaryAndRequestId() {
        val current = AranetReading("AA", "Aranet4", 1_000, 612, 224, 462, 10086, 87, 1)
        val snapshot = SnapshotAggregator.build(
            listOf(current), "HOME", 1_000, ChartScale.DAY, ZoneId.of("UTC"),
        )!!
        val message = PebbleProtocol.snapshot(snapshot, 17, 1_000)
        assertEquals(17.toUShort(), (message[PebbleProtocol.REQUEST_ID.toUInt()] as PebbleDictionaryItem.UInt16).value)
        assertEquals(612, (message[PebbleProtocol.CO2.toUInt()] as PebbleDictionaryItem.Int32).value)
        assertEquals(224, (message[PebbleProtocol.TEMP_X10.toUInt()] as PebbleDictionaryItem.Int32).value)
        assertEquals(10086, (message[PebbleProtocol.PRESSURE_X10.toUInt()] as PebbleDictionaryItem.Int32).value)
        assertEquals(1.toUByte(), (message[PebbleProtocol.SCALE.toUInt()] as PebbleDictionaryItem.UInt8).value)
        assertTrue(message.containsKey(54u))
    }
}
