package com.peekalo.captureguard

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import java.util.WeakHashMap

// An in-Activity opaque view, never a new Window or hidden Activity. Keeping this
// UID visible avoids using our own cover to force a NOT_VISIBLE recording report.
// The view retains its accessibility restoration data across JS/module reloads.
internal class CaptureCover private constructor(activity: Activity) : FrameLayout(activity) {
  companion object {
    private const val COVER_TAG = "peekalo-native-capture-guard-cover"
    fun forActivity(activity: Activity): CaptureCover {
      val decor = activity.window.decorView as? ViewGroup ?: error("Activity decor unavailable")
      for (i in 0 until decor.childCount) {
        val child = decor.getChildAt(i)
        if (child.tag == COVER_TAG) return child as? CaptureCover ?: error("Capture cover conflict")
      }
      return CaptureCover(activity)
    }
  }

  private val decor = activity.window.decorView as? ViewGroup ?: error("Activity decor unavailable")
  private val hiddenAccessibility = WeakHashMap<View, Int>()
  private val message = TextView(activity)
  private val retry = Button(activity)
  private var observing = false
  var onRetry: (() -> Unit)? = null
  private val beforeDraw = ViewTreeObserver.OnPreDrawListener {
    if (visibility == VISIBLE) keepAboveContent()
    true
  }

  init {
    tag = COVER_TAG
    // Emergency native adapter to @peekalo/design semantic values: this cover
    // must be available before JavaScript/fonts or React content can initialize.
    setBackgroundColor(Color.rgb(8, 10, 9)) // background #080a09
    alpha = 1f
    elevation = 100_000f
    isClickable = true
    isFocusable = true
    isFocusableInTouchMode = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    if (Build.VERSION.SDK_INT >= 28) accessibilityPaneTitle = "Peekalo screen protection"
    val column = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      val padding = (24 * resources.displayMetrics.density).toInt() // space.lg
      setPadding(padding, padding, padding, padding)
    }
    message.apply {
      setTextColor(Color.rgb(241, 242, 237)) // text #f1f2ed
      textSize = 18f // type.section
      gravity = Gravity.CENTER
      importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    retry.apply {
      text = "Try again"
      isAllCaps = false
      backgroundTintList = ColorStateList.valueOf(Color.rgb(212, 250, 113)) // accent #d4fa71
      setTextColor(Color.rgb(19, 26, 13)) // onAccent #131a0d
      setOnClickListener { onRetry?.invoke() }
    }
    column.addView(message, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    column.addView(retry, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
    addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
  }

  fun block(status: CaptureStatus, checking: Boolean) {
    val newlyBlocking = visibility != VISIBLE || parent !== decor
    message.text = when {
      checking -> "Checking screen recording…"
      status == CaptureStatus.RECORDING -> "Stop screen recording to use Peekalo."
      else -> "Screen recording status is unavailable. Try again."
    }
    retry.visibility = if (!checking && status == CaptureStatus.UNAVAILABLE) VISIBLE else GONE
    retry.isEnabled = onRetry != null
    visibility = VISIBLE
    if (!observing) {
      decor.viewTreeObserver.addOnPreDrawListener(beforeDraw)
      observing = true
    }
    keepAboveContent()
    if (newlyBlocking) {
      // Cancel an already-held gesture underneath the opaque cover as well as
      // intercepting new touches. No content or pointer coordinates are logged.
      val now = SystemClock.uptimeMillis()
      val cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
      try { decor.dispatchTouchEvent(cancel) } finally { cancel.recycle() }
    }
    requestFocus()
  }

  private fun keepAboveContent() {
    if (parent !== decor) {
      (parent as? ViewGroup)?.removeView(this)
      decor.addView(this, ViewGroup.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    // Restore our full opacity even if app content/layout changes after blocking.
    alpha = 1f
    if (decor.getChildAt(decor.childCount - 1) !== this) bringToFront()
    for (i in 0 until decor.childCount) {
      val child = decor.getChildAt(i)
      if (child !== this) {
        if (!hiddenAccessibility.containsKey(child)) hiddenAccessibility[child] = child.importantForAccessibility
        child.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      }
    }
  }

  fun clear() {
    if (observing && decor.viewTreeObserver.isAlive) decor.viewTreeObserver.removeOnPreDrawListener(beforeDraw)
    observing = false
    visibility = GONE
    hiddenAccessibility.forEach { (view, previous) -> view.importantForAccessibility = previous }
    hiddenAccessibility.clear()
  }
}
