package com.fieldcast

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.webkit.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val PERMISSION_REQUEST = 100

    // Update this URL for production
    private val APP_URL = "https://app.yourdomain.com"
    // For local dev testing:
    // private val APP_URL = "http://192.168.x.x:3001"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        // Request camera and mic permissions
        requestPermissions()

        setupWebView()
        webView.loadUrl(APP_URL)
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled          = true
            domStorageEnabled          = true   // localStorage for auth tokens
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess            = true
            allowContentAccess         = true
            useWideViewPort            = true
            loadWithOverviewMode       = true
            setSupportZoom(false)
        }

        // Allow camera and mic access from web app
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                // Show offline page if server unreachable
                if (request.isForMainFrame) {
                    view.loadData(
                        "<html><body style='background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif'>" +
                        "<div style='text-align:center'><h2 style='color:#E24B4A'>● FieldCast</h2>" +
                        "<p style='color:#666;margin-top:8px'>Could not connect to server.<br>Check your internet connection.</p></div></body></html>",
                        "text/html", "UTF-8"
                    )
                }
            }
        }
    }

    private fun requestPermissions() {
        val permissions = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
        )
        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQUEST)
        }
    }

    // Handle back button — navigate back in WebView instead of closing app
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }
}
