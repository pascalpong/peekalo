package com.peekalo.captureguard

import org.junit.Assert.*
import org.junit.Test

class ActiveTouchStreamTest {
  private data class Event(val downTime: Long, val pointers: List<Int>, val x: Int)

  @Test fun cancelUsesLatestRealStreamDataAndTransfersItsOwnedCopyOnlyOnce() {
    val recycled = mutableListOf<Event>()
    val stream = ActiveTouchStream<Event>({ it.copy(pointers = it.pointers.toList()) }, { recycled.add(it) })
    val down = Event(1234L, listOf(0), 10)
    stream.start(down.downTime, down)
    stream.update(1234L, Event(1234L, listOf(0, 2), 30))
    val cancel = stream.takeForCancel()!!
    assertEquals(Event(1234L, listOf(0, 2), 30), cancel)
    assertNotSame(down, cancel)
    assertEquals(listOf(down), recycled)
    assertNull(stream.takeForCancel())
    stream.clear()
    assertEquals(1, recycled.size) // Caller owns/recycles the transferred cancel.
  }

  @Test fun noDownOrFinishedGestureNeverGeneratesACancel() {
    val recycled = mutableListOf<Event>()
    val stream = ActiveTouchStream<Event>({ it.copy() }, { recycled.add(it) })
    stream.update(50L, Event(50L, listOf(0), 1))
    assertNull(stream.takeForCancel())
    stream.start(70L, Event(70L, listOf(0), 2))
    stream.clear() // Actual UP or CANCEL.
    assertNull(stream.takeForCancel())
    assertEquals(1, recycled.size)
  }

  @Test fun mismatchedStreamCannotReuseStaleDownTimeOrPointers() {
    val recycled = mutableListOf<Event>()
    val stream = ActiveTouchStream<Event>({ it.copy() }, { recycled.add(it) })
    stream.start(100L, Event(100L, listOf(3), 4))
    stream.update(200L, Event(200L, listOf(7), 5))
    assertNull(stream.takeForCancel())
    assertEquals(listOf(Event(100L, listOf(3), 4)), recycled)
  }

  @Test fun nextRealDownReleasesPreviousStreamAndCanBeCancelledIndependently() {
    val recycled = mutableListOf<Event>()
    val stream = ActiveTouchStream<Event>({ it.copy() }, { recycled.add(it) })
    stream.start(100L, Event(100L, listOf(0), 1))
    stream.start(300L, Event(300L, listOf(1), 8))
    assertEquals(listOf(Event(100L, listOf(0), 1)), recycled)
    assertEquals(Event(300L, listOf(1), 8), stream.takeForCancel())
  }
}
