package com.peekalo.captureguard

import org.junit.Assert.*
import org.junit.Test

class CaptureGuardStateTest {
  @Test fun nativeCoverPrecedesEveryPublishedState() {
    val order = mutableListOf<String>()
    val state = CaptureGuardState({ order.add("cover:${it.wireValue}") }, { order.add("event:${it.status.wireValue}") })
    val epoch = state.invalidate()
    state.accept(epoch, CaptureStatus.RECORDING)
    assertEquals(listOf("cover:unavailable", "event:unavailable", "cover:recording", "event:recording"), order)
  }

  @Test fun registrationEpochRejectsOldClearCallbackAfterRefreshOrPause() {
    val states = mutableListOf<CaptureStatus>()
    val state = CaptureGuardState({}, { states.add(it.status) })
    val old = state.invalidate()
    state.accept(old, CaptureStatus.CLEAR)
    val fresh = state.invalidate()
    assertFalse(state.accept(old, CaptureStatus.CLEAR))
    assertEquals(CaptureStatus.UNAVAILABLE, state.snapshot.status)
    assertTrue(state.accept(fresh, CaptureStatus.RECORDING))
    assertEquals(listOf(CaptureStatus.UNAVAILABLE, CaptureStatus.CLEAR, CaptureStatus.UNAVAILABLE, CaptureStatus.RECORDING), states)
  }

  @Test fun revisionNeverResetsAcrossRegistrationsAndRepeatedStates() {
    val revisions = mutableListOf<Long>()
    val state = CaptureGuardState({}, { revisions.add(it.revision) })
    repeat(3) {
      val epoch = state.invalidate()
      state.accept(epoch, CaptureStatus.CLEAR)
      state.accept(epoch, CaptureStatus.CLEAR)
    }
    assertEquals((1L..9L).toList(), revisions)
  }

  @Test fun failedCoverCannotPublishClearAndAttemptsUnavailableCoverBeforeEvent() {
    val order = mutableListOf<String>()
    val state = CaptureGuardState({
      order.add("cover:${it.wireValue}")
      if (it == CaptureStatus.CLEAR) error("native cover operation failed")
    }, { order.add("event:${it.status.wireValue}") })
    val epoch = state.invalidate()
    state.accept(epoch, CaptureStatus.CLEAR)
    assertEquals(CaptureStatus.UNAVAILABLE, state.snapshot.status)
    assertEquals(listOf("cover:unavailable", "event:unavailable", "cover:clear", "cover:unavailable", "event:unavailable"), order)
  }

  @Test fun unsupportedIsAnExplicitStateRatherThanClear() {
    val state = CaptureGuardState({}, {})
    val epoch = state.invalidate()
    state.accept(epoch, CaptureStatus.UNSUPPORTED)
    assertEquals(mapOf("status" to "unsupported", "revision" to 2L), state.snapshot.payload())
  }
}
