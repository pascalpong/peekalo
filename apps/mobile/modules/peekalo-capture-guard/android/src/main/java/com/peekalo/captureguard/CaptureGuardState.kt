package com.peekalo.captureguard

internal enum class CaptureStatus(val wireValue: String) {
  CLEAR("clear"), RECORDING("recording"), UNAVAILABLE("unavailable"), UNSUPPORTED("unsupported")
}

internal data class CaptureSnapshot(val status: CaptureStatus, val revision: Long) {
  fun payload(): Map<String, Any?> = mapOf("status" to status.wireValue, "revision" to revision)
}

// Main-thread state machine. Each registration has an epoch; revisions span every
// refresh in this module instance. Native pixels/input are covered before JS hears
// about any transition. A cover error can never publish a clear state.
internal class CaptureGuardState(
  private val applyCover: (CaptureStatus) -> Unit,
  private val emit: (CaptureSnapshot) -> Unit
) {
  var epoch = 0L
    private set
  var snapshot = CaptureSnapshot(CaptureStatus.UNAVAILABLE, 0)
    private set

  fun invalidate(): Long {
    epoch += 1
    publish(CaptureStatus.UNAVAILABLE)
    return epoch
  }

  fun accept(expectedEpoch: Long, status: CaptureStatus): Boolean {
    if (expectedEpoch != epoch) return false
    publish(status)
    return true
  }

  fun publish(status: CaptureStatus) {
    var safeStatus = status
    try {
      applyCover(status)
    } catch (_: Throwable) {
      safeStatus = CaptureStatus.UNAVAILABLE
      try { applyCover(safeStatus) } catch (_: Throwable) { /* JS remains blocked. */ }
    }
    snapshot = CaptureSnapshot(safeStatus, snapshot.revision + 1)
    try { emit(snapshot) } catch (_: Throwable) { /* Context may already be gone. */ }
  }
}
