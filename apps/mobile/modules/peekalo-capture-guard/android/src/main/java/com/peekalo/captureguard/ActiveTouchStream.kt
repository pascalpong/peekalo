package com.peekalo.captureguard

// Owns one copied event from a real DOWN stream. Taking it transfers ownership
// to the cancel dispatcher, which must release it after dispatch. No timestamps
// or pointer data are invented, logged or persisted.
internal class ActiveTouchStream<T>(
  private val copy: (T) -> T,
  private val release: (T) -> Unit
) {
  private var downTime: Long? = null
  private var event: T? = null

  fun start(startTime: Long, value: T) {
    clear()
    event = copy(value)
    downTime = startTime
  }

  fun update(startTime: Long, value: T) {
    if (event == null) return
    if (downTime != startTime) { clear(); return }
    val next = copy(value)
    event?.let(release)
    event = next
  }

  fun clear() {
    event?.let(release)
    event = null
    downTime = null
  }

  fun takeForCancel(): T? {
    val current = event
    event = null
    downTime = null
    return current
  }
}
