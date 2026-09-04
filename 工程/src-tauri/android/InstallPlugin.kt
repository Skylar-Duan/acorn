package com.cdpandas.acorn

// 把下好的 APK 交给系统安装器。橡果自己的安卓插件：Rust 侧（lib.rs）按
// register_android_plugin("com.cdpandas.acorn", "InstallPlugin") 反射加载，前端命令是 install_apk。
//
// 为什么不用官方 opener 插件的 openPath：它的安卓实现只有一个 open(url)，拿到缓存目录里的
// 裸文件路径就直接 Intent(ACTION_VIEW, path.toUri())——没有 content:// 也没有 mime，
// 系统找不到能开它的 Activity，每一台手机都失败。v1.12.0 之前 App 内安装从来没成功过就是这个原因。
//
// 这里做对的三件事：
//   1. Android 8 起装应用要先在系统里给橡果开「允许安装未知应用」。没开就把人送到那个开关，
//      回 { launched: false, reason: "permission" }，让界面说人话（不是红字）。
//   2. 文件必须经 FileProvider 变成 content:// URI 才递得给别的应用（API 24 起裸 file:// 直接抛
//      FileUriExposedException）。AndroidManifest 里 provider 的 authorities 是 ${applicationId}.fileprovider，
//      res/xml/file_paths.xml 里 <cache-path path="."/> 正好盖住 Tauri 的 app_cache_dir（= getCacheDir）。
//   3. Intent 要带 APK 的 mime（application/vnd.android.package-archive）和读权限 flag，安装器才认。
//
// 回话只有三种：{ launched: true }、{ launched: false, reason: "permission" }（先去开开关）、
// { launched: false, reason: "missing" }（递来的包已经不在缓存里，前端会重新下）。
// 任何异常一律 reject(ex.toString())——带类名。光 ex.message 常常是 null，界面上就成了「（原因：null）」。

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallArgs {
  /** 缓存目录里那个 APK 的绝对路径（save_download 落盘时返回的那一串） */
  lateinit var path: String
}

@TauriPlugin
class InstallPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun install(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(InstallArgs::class.java)
      val ctx = activity.applicationContext

      // 1. 「允许安装未知应用」还没给橡果开：送去开关，这次什么都不装
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
        val ask = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
        ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
          activity.startActivity(ask)
        } catch (_: ActivityNotFoundException) {
          // 个别定制系统不认带 package: 的那种，退一步开总开关页
          ask.data = null
          activity.startActivity(ask)
        }
        val out = JSObject()
        out.put("launched", false)
        out.put("reason", "permission")
        invoke.resolve(out)
        return
      }

      // 2. 裸路径变 content:// URI。
      //    上一次下好、只差开开关的包这次会原路复用（不重下 12MB）；要是系统趁这会儿把缓存清了，
      //    回 reason: "missing" 让前端当场重新下——这不是失败，别 reject
      val file = File(args.path)
      if (!file.isFile) {
        val out = JSObject()
        out.put("launched", false)
        out.put("reason", "missing")
        invoke.resolve(out)
        return
      }
      val uri: Uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)

      // 3. 带 mime 和读权限拉起系统安装界面
      val intent = Intent(Intent.ACTION_VIEW)
      intent.setDataAndType(uri, "application/vnd.android.package-archive")
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      activity.startActivity(intent)

      val out = JSObject()
      out.put("launched", true)
      invoke.resolve(out)
    } catch (ex: Exception) {
      invoke.reject(ex.toString())
    }
  }
}
