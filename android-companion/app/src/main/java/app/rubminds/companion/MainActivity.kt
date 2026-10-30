package app.rubminds.companion

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

private data class LaunchableApp(
    val packageName: String,
    val label: String,
    val icon: android.graphics.drawable.Drawable
)

class MainActivity : Activity() {
    private lateinit var store: AppGrantStore
    private lateinit var list: LinearLayout
    private val launchGrants = linkedSetOf<String>()
    private val draftGrants = linkedSetOf<String>()
    private val appRows = mutableMapOf<String, Pair<CheckBox, CheckBox>>()
    private var apps: List<LaunchableApp> = emptyList()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = AppGrantStore(this)
        store.all().forEach {
            launchGrants += it.packageName
            if (it.allowDraftInsertion) draftGrants += it.packageName
        }
        render()
        discoverApps()
    }

    private fun render() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(16))
        }
        root.addView(TextView(this).apply {
            text = "Connect apps to Rub Minds"
            textSize = 24f
            setTextColor(0xff172033.toInt())
        })
        root.addView(TextView(this).apply {
            text = "Choose the apps Rub Minds may open. Draft insertion is a separate permission you control for each app."
            textSize = 15f
            setTextColor(0xff4b5563.toInt())
            setPadding(0, dp(8), 0, dp(12))
        })

        root.addView(TextView(this).apply {
            text = "This first companion build discovers apps with launcher icons. It does not read their private data, messages, passwords, notifications or screens."
            textSize = 13f
            setTextColor(0xff374151.toInt())
            setBackgroundColor(0xffeef2ff.toInt())
            setPadding(dp(12), dp(12), dp(12), dp(12))
        })

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        actions.addView(Button(this).apply {
            text = "Save app choices"
            setOnClickListener { saveChoices() }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(Button(this).apply {
            text = "Keyboard settings"
            setOnClickListener { startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)) }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(actions)

        root.addView(TextView(this).apply {
            text = "Installed apps"
            textSize = 18f
            setTextColor(0xff172033.toInt())
            setPadding(0, dp(16), 0, dp(8))
        })
        val scroll = ScrollView(this)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll.addView(list)
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        root.addView(TextView(this).apply {
            text = "To enable draft insertion, save your choices, open Android Keyboard settings, enable “Rub Minds draft keyboard”, then select it as the active keyboard. Android controls this approval; Rub Minds cannot enable itself."
            textSize = 12f
            setTextColor(0xff4b5563.toInt())
            setPadding(0, dp(12), 0, 0)
        })
        setContentView(root)
    }

    private fun discoverApps() {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        @Suppress("DEPRECATION")
        val resolved = packageManager.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        apps = resolved.mapNotNull { info ->
            val appPackage = info.activityInfo?.packageName ?: return@mapNotNull null
            if (appPackage == applicationContext.packageName) return@mapNotNull null
            val label = info.loadLabel(packageManager)?.toString()?.takeIf { it.isNotBlank() } ?: appPackage
            LaunchableApp(appPackage, label, info.loadIcon(packageManager))
        }.distinctBy { it.packageName }.sortedBy { it.label.lowercase() }
        drawAppRows()
    }

    private fun drawAppRows() {
        list.removeAllViews()
        appRows.clear()
        if (apps.isEmpty()) {
            list.addView(TextView(this).apply { text = "No launchable apps were discovered." })
            return
        }
        apps.forEach { app ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(8), 0, dp(8))
            }
            val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
            header.addView(ImageView(this).apply { setImageDrawable(app.icon) },
                LinearLayout.LayoutParams(dp(40), dp(40)))
            header.addView(TextView(this).apply {
                text = app.label
                textSize = 16f
                setTextColor(0xff172033.toInt())
                setPadding(dp(10), 0, dp(8), 0)
            }, LinearLayout.LayoutParams(0, -2, 1f))
            header.addView(Button(this).apply {
                text = "Open"
                setOnClickListener { openSelectedApp(app.packageName) }
            })
            val add = CheckBox(this).apply {
                text = "Add this app"
                isChecked = app.packageName in launchGrants
                setOnCheckedChangeListener { _, checked ->
                    if (checked) {
                        launchGrants += app.packageName
                    } else {
                        launchGrants -= app.packageName
                        draftGrants -= app.packageName
                        appRows[app.packageName]?.second?.isChecked = false
                    }
                    appRows[app.packageName]?.second?.isEnabled = checked
                }
            }
            header.addView(add)
            row.addView(header)

            val draft = CheckBox(this).apply {
                text = "Allow draft insertion with Rub Minds keyboard"
                isChecked = app.packageName in draftGrants
                isEnabled = app.packageName in launchGrants
                setOnCheckedChangeListener { _, checked ->
                    if (checked) {
                        if (app.packageName !in launchGrants) {
                            isChecked = false
                            Toast.makeText(this@MainActivity, "Add this app first.", Toast.LENGTH_SHORT).show()
                        } else {
                            draftGrants += app.packageName
                        }
                    } else {
                        draftGrants -= app.packageName
                    }
                }
            }
            row.addView(draft)
            row.addView(View(this).apply { setBackgroundColor(0xffe5e7eb.toInt()) },
                LinearLayout.LayoutParams(-1, dp(1)))
            list.addView(row)
            appRows[app.packageName] = add to draft
        }
    }

    private fun openSelectedApp(packageName: String) {
        if (packageName !in launchGrants || !AppGrantPolicy.canLaunch(store.get(packageName))) {
            Toast.makeText(this, "Save this app as an allowed app first.", Toast.LENGTH_SHORT).show()
            return
        }
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        if (launchIntent == null) {
            Toast.makeText(this, "Android did not provide a launch activity for this app.", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(launchIntent)
    }

    private fun saveChoices() {
        val grants = launchGrants.map { packageName ->
            AppGrant(packageName, allowLaunch = true, allowDraftInsertion = packageName in draftGrants)
        }
        store.save(grants)
        appRows.forEach { (packageName, row) ->
            row.second.isEnabled = packageName in launchGrants
        }
        Toast.makeText(this, "App permissions saved on this phone.", Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
