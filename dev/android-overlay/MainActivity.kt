package org.caprichosos.chismoso

import android.app.UiModeManager
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.system.Os
import android.view.View
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Android TV (and Google TV): tell the app, which turns on TV mode
    // (platform::Features::tv reads CHISMOSO_TV), and keep the screen on, so
    // a camera wall isn't covered by the screensaver after a few minutes
    // without a button press. Phones keep their normal screen timeout.
    val uiMode = (getSystemService(UI_MODE_SERVICE) as UiModeManager).currentModeType
    val tv = uiMode == Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    if (tv) {
      Os.setenv("CHISMOSO_TV", "1", true)
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // Android 15+ always draws apps edge to edge. The app is dark, so use
    // light status/navigation icons, and keep the page clear of the bars,
    // the camera cutout and the keyboard by padding the content view.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.parseColor("#0B0F16"))
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
