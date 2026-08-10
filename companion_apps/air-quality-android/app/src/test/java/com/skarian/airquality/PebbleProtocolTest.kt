package com.skarian.airquality

import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PebbleProtocolTest {
    @Test
    fun emitsMatchingFourMetricDictionaryAndRequestId() {
        val current = AranetReading("AA", "Aranet4", 1_000, 612, 224, 462, 10086, 87, 1)
        val snapshot = SnapshotAggregator.build(
            listOf(current), "HOME", 1_000, ChartScale.DAY,
        )!!
        val message = PebbleProtocol.snapshot(snapshot, 17, 1_000)
        assertEquals(PebbleProtocol.PROTOCOL_VERSION.toUByte(),
            (message[PebbleProtocol.PROTOCOL.toUInt()] as PebbleDictionaryItem.UInt8).value)
        assertEquals(17.toUShort(), (message[PebbleProtocol.REQUEST_ID.toUInt()] as PebbleDictionaryItem.UInt16).value)
        assertEquals(612, (message[PebbleProtocol.CO2.toUInt()] as PebbleDictionaryItem.Int32).value)
        assertEquals(224, (message[PebbleProtocol.TEMP_X10.toUInt()] as PebbleDictionaryItem.Int32).value)
        assertEquals(10086, (message[PebbleProtocol.PRESSURE_X10.toUInt()] as PebbleDictionaryItem.Int32).value)
        assertEquals(1.toUByte(), (message[PebbleProtocol.SCALE.toUInt()] as PebbleDictionaryItem.UInt8).value)
        assertEquals(GRAPH_COLUMNS.toUByte(),
            (message[PebbleProtocol.POINT_COUNT.toUInt()] as PebbleDictionaryItem.UInt8).value)
        assertEquals(GRAPH_COLUMNS * 2,
            (message[PebbleProtocol.SERIES_CO2.toUInt()] as PebbleDictionaryItem.Bytes).value.size)
        assertTrue(message.containsKey(PebbleProtocol.AVG_PRESSURE_X10.toUInt()))
    }

    @Test
    fun `cached and stale flags remain independent`() {
        val current = AranetReading("AA", "Aranet4", 1_000, 612, 224, 462, 10086, 87, 1)
        val snapshot = SnapshotAggregator.build(
            listOf(current), "HOME", 1_000, ChartScale.HOUR,
        )!!

        val freshCached = PebbleProtocol.snapshot(snapshot, 18, 1_000, cached = true)
        val staleCached = PebbleProtocol.snapshot(snapshot, 18, 3_000, cached = true)

        assertEquals(
            PebbleProtocol.FLAG_CACHED.toUByte(),
            (freshCached[PebbleProtocol.FLAGS.toUInt()] as PebbleDictionaryItem.UInt8).value,
        )
        assertEquals(
            (PebbleProtocol.FLAG_CACHED or PebbleProtocol.FLAG_STALE).toUByte(),
            (staleCached[PebbleProtocol.FLAGS.toUInt()] as PebbleDictionaryItem.UInt8).value,
        )
    }
}
