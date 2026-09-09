package com.cdpandas.acorn

// 把下好的 APK 装上。橡果自己的安卓插件：Rust 侧（lib.rs）按
// register_android_plugin("com.cdpandas.acorn", "InstallPlugin") 反射加载，
// 前端命令两条：install_apk（动手装）、install_status（问上一次装成了没）。
//
// ---------- 为什么 v1.14.2 把主路从 ACTION_VIEW 换成 PackageInstaller ----------
// v1.13.0 / v1.14.0 走的是 Intent(ACTION_VIEW) + FileProvider——「把 APK 丢给系统的安装器 Activity」。
// 用户在真机上仍然装不上。这条路有两个死穴：
//   1. 各家定制系统（MIUI / HyperOS / ColorOS / 鸿蒙）在这条路上加了自己的拦截，丢过去可能就没下文；
//   2. **失败了我们什么都拿不到**：Activity 起来了就算成功。装没装成、为什么没装成，App 一无所知——
//      用户只能说「装不上」，我们只能猜。三个版本查不出根因就是栽在这里。
// 真正能自更新的 App 走的是**会话 API**：自己开 session、把 APK 字节写进去、commit，
// 系统再通过 PendingIntent 把**带状态码和原因**的结果广播回来（STATUS_SUCCESS /
// FAILURE_BLOCKED / CONFLICT / INCOMPATIBLE / INVALID / STORAGE / ABORTED，外加
// EXTRA_STATUS_MESSAGE 那句系统原话）。有了它，界面上那行小字才写得出真原因。
// 附带的好处：会话这条路自己读自己缓存目录里的文件，不再需要把 content:// 递给别的应用，
// FileProvider 那一圈权限问题整个绕开了。
//
// 这里做对的几件事：
//   0. **会话那段活儿不许在主线程干**：开完会话要把 13MB 的 APK 整个拷进去再 fsync，
//      慢存储上能到秒级，主线程卡住就是界面全不响应、极端情况直接「橡果无响应」（ANR）——
//      而这恰好会砸在最该照顾的那类机器上。所以 install() 只留两个便宜的检查，
//      开会话 / 写字节 / commit 全丢给一条工作线程，回话由它自己 resolve（跨线程回话是安全的，
//      见 install() 里的注释）。老的 ACTION_VIEW 那条一次磁盘 IO 都没有，所以以前没这个问题。
//   1. Android 8 起装应用要先在系统里给橡果开「允许安装未知应用」。没开就把人送到那个开关，
//      回 { launched: false, reason: "permission" }，让界面说人话（不是红字）。语义跟以前一样。
//   2. 结果广播用**运行时注册**的 BroadcastReceiver 接：AndroidManifest 在 gen/android 里是可再生的，
//      不往里加东西。注册走 ContextCompat.registerReceiver + RECEIVER_NOT_EXPORTED：Android 13 以上
//      是系统的 flag，13 以下 androidx 自动改用一条签名级权限——不然裸注册出来的接收器对外开放，
//      别的应用能广播一条假终态进来（minSdk 24，这段区间是真实存在的）。
//      PendingIntent 在 API 31（S）起必须显式 FLAG_MUTABLE——系统要往里塞状态 extra，
//      不可变的 PendingIntent 会让 createSession 之后的 commit 直接抛 IllegalArgumentException。
//      接收器、终态、会话号全挂在 companion object 上（**进程级**）：Activity 一重建，
//      Tauri 会新建一个插件实例，挂实例上的话终态会被旧实例吞掉、新实例永远答「还没有结果」。
//   3. STATUS_PENDING_USER_ACTION 不是终态，是「系统要用户亲手点一下安装」：确认页放在
//      EXTRA_INTENT 里，由我们拉起来。拉不起来才记成失败。
//   4. 终态记在 last 里，前端用 install_status 取（顺手 trigger 一条事件，将来想改成推送很容易）。
//      为什么是「问」不是「推」：装成功的那一刻系统会把橡果这个进程换掉，推也推不到；
//      而问这条命令在 App 被系统杀掉又重开之后仍然答得上来。
//   5. **ACTION_VIEW 那条留着当兜底**：会话 API 抛异常（个别系统真把它锁了）就退回去走它，
//      回话里 mode = "view" 并带上主路失败的原话，界面据此标明「走的是兜底那条」。
//   6. 包不在（reason "missing"）语义不变：前端当场重下，不算失败，别 reject。
//
// 回话长这样：
//   install     → { launched: true,  mode: "session", session: N }
//               | { launched: true,  mode: "view", fallback: "主路为什么没走成" }
//               | { launched: false, reason: "permission" | "missing" }
//               | reject(原话)
//   lastResult  → { done: false } | { done: true, ok, status, code, message }
// 任何异常一律带类名（ex.toString()）：光 ex.message 常常是 null，界面上就成了「（原因：null）」。

import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.lang.ref.WeakReference
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@InvokeArg
class InstallArgs {
  /** 缓存目录里那个 APK 的绝对路径（save_download 落盘时返回的那一串） */
  lateinit var path: String
}

@TauriPlugin
class InstallPlugin(private val activity: Activity) : Plugin(activity) {
  init {
    // 让结果广播找得到「此刻活着的那个插件实例」（trigger 要用）。
    // Activity 重建（改字体大小 / 显示大小就会）会让 Tauri 新建一个 InstallPlugin，
    // 而接收器是进程级的、注册一次就不动——所以认实例这件事只能反过来做：新实例自己来报到。
    newest = WeakReference(this)
  }

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

      // 2. 上一次下好、只差开开关的包这次会原路复用（不重下 12MB）；要是系统趁这会儿把缓存清了，
      //    回 reason "missing" 让前端当场重新下——这不是失败，别 reject。
      //    长度为 0 也当没有：那是一份下到一半的坏包，装上去只会得到「解析包时出现问题」
      val file = File(args.path)
      if (!file.isFile || file.length() <= 0L) {
        val out = JSObject()
        out.put("launched", false)
        out.put("reason", "missing")
        invoke.resolve(out)
        return
      }

      // 新的一次交接：把上一次的终态清掉，免得前端把上回的失败原因挂到这回头上。
      // 同时**这一刻起不认任何回执**（liveSession = NO_SESSION）：上一轮那个还挂着的会话
      // 马上要被丢弃，它回的 STATUS_FAILURE_ABORTED 不是这一轮的结果，不能画到界面上
      last = null
      val prev = liveSession
      liveSession = NO_SESSION

      // 3. 主路那段活儿**不能在主线程干**：开会话之后要把 13MB 的 APK 整个拷进去再 fsync，
      //    慢存储 / 存储将满的机器上这一段能到秒级，主线程卡住就是界面全不响应，极端情况直接
      //    「橡果无响应」（ANR）。插件的方法是 Tauri 从安卓 UI 线程同步调进来的
      //    （run_on_android_context → PluginManager.runCommand → 本方法），所以这里只留两个
      //    便宜的检查，真正的活儿丢给工作线程，回话由它自己 resolve。
      //    Invoke 的回话跨线程是安全的：resolve 走 PluginManager 的 handlePluginResponse（JNI），
      //    Rust 侧只是从一张全局表里取出等待者、往 channel 里送一下（tauri 2.11.5
      //    plugin/mobile.rs 的 handle_android_plugin_response），没有任何「必须主线程」的东西；
      //    发起那头 run_mobile_plugin 本来就是阻塞等这条回话，等在哪个线程它不关心。
      worker.execute { runInstall(invoke, ctx, file, prev) }
    } catch (ex: Exception) {
      invoke.reject(ex.toString())
    }
  }

  /**
   * 真正动手的那一段（工作线程）：丢掉上一轮的会话 → 走主路 → 主路不行退兜底 → 回话。
   * 这里面每一步都可能碰盘或者跨进程，所以整段都不许回到主线程上跑。
   *
   * **这里必须兜住一切**（Throwable，不只是 Exception）：主线程那条路上，漏出去的异常还有
   * PluginManager 的 try/catch 接着、会替我们 reject；挪到工作线程之后就没有这张网了，
   * 一条没人接的异常 = 前端那句 await 永远不返回 = 界面永远停在「安装中」，出口全没了。
   */
  private fun runInstall(invoke: Invoke, ctx: Context, file: File, prev: Int) {
    try {
      // 上一轮还挂着的会话（人在系统确认页上没点、直接回橡果又点了一次「重试」）先丢掉。
      // 不丢的话它迟早回一条 ABORTED，而 requestCode 是按会话号分开的、两个 PendingIntent 都活着
      abandon(ctx, prev)

      // 主路：PackageInstaller 会话。装成没装成、为什么，全靠它回话
      val sessionId = try {
        startSession(ctx, file)
      } catch (ex: Exception) {
        // 主路起不来（个别系统锁了会话 API、写不进去、commit 被拒）：退回老路 ACTION_VIEW。
        // 它装不装得上我们仍然不知道，但至少还有一次机会——回话里说清走的是兜底那条
        val why = ex.toString()
        try {
          startViewer(ctx, file)
        } catch (fallbackEx: Exception) {
          invoke.reject("系统的安装会话起不来（$why）；兜底的安装界面也没起来（$fallbackEx）")
          return
        }
        val out = JSObject()
        out.put("launched", true)
        out.put("mode", "view")
        out.put("fallback", why)
        invoke.resolve(out)
        return
      }

      val out = JSObject()
      out.put("launched", true)
      out.put("mode", "session")
      out.put("session", sessionId)
      invoke.resolve(out)
    } catch (ex: Throwable) {
      invoke.reject(ex.toString())
    }
  }

  /**
   * 上一次交出去的那个包，装成了没。
   *
   * `{ done: false }` = 还没有结果（系统的确认页多半还开着）。
   * `{ done: true, ok, status, code, message }` = 有终态了，status 是 PackageInstaller 的原始数字，
   * message 是 EXTRA_STATUS_MESSAGE 的系统原话——这两样一起交给界面那行小字，用户截图就能查。
   */
  @Command
  fun lastResult(invoke: Invoke) {
    val done = last
    if (done != null) {
      invoke.resolve(done)
      return
    }
    val idle = JSObject()
    idle.put("done", false)
    invoke.resolve(idle)
  }

  // ---------- 主路：会话 ----------

  /** 开会话 → 写字节 → commit。任何一步出事就把会话丢掉再把异常抛出去（外面退兜底那条） */
  private fun startSession(ctx: Context, file: File): Int {
    ensureReceiver(ctx)
    val installer = ctx.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    // 装的是橡果自己（自更新）。写明白，系统的确认页才知道该显示哪个应用
    params.setAppPackageName(ctx.packageName)
    params.setSize(file.length())

    val id = installer.createSession(params)
    // 从这一刻起只认这个会话的回执（见 onSessionStatus 的会话号那一关）
    liveSession = id
    try {
      installer.openSession(id).use { session ->
        session.openWrite(WRITE_NAME, 0, file.length()).use { out ->
          FileInputStream(file).use { input -> input.copyTo(out, 1 shl 16) }
          // fsync 之后才能关流：不落盘的话 commit 拿到的是半份包
          session.fsync(out)
        }
        session.commit(resultSender(ctx, id))
      }
    } catch (ex: Exception) {
      // 这个会话没起来：别再认它的回执，也别把它留在系统里
      liveSession = NO_SESSION
      try {
        installer.abandonSession(id)
      } catch (_: Exception) {
        // 会话本来就没建成 / 已经没了，无所谓
      }
      throw ex
    }
    return id
  }

  /**
   * 把上一轮那个还挂着的会话丢掉。
   *
   * 什么时候会有：人点了更新 → 系统确认页弹出来 → 他直接返回橡果 → 又点一次「重试」。
   * 第一个会话还开着，它的 PendingIntent 也还活着（requestCode 按会话号分开）；
   * 迟早会回一条 STATUS_FAILURE_ABORTED，那不是这一轮的结果。
   * 调用之前 liveSession 已经清成 NO_SESSION，所以这条丢弃引发的广播一定被 onSessionStatus 挡掉。
   */
  private fun abandon(ctx: Context, id: Int) {
    if (id < 0) return
    try {
      ctx.packageManager.packageInstaller.abandonSession(id)
    } catch (_: Exception) {
      // 早就没了（装完 / 被系统清了 / 根本不是我们的），无所谓
    }
  }

  /** commit 用的回执通道。API 31 起 PendingIntent 必须显式可变——系统要往里塞状态 extra */
  private fun resultSender(ctx: Context, sessionId: Int): IntentSender {
    val intent = Intent(RESULT_ACTION).setPackage(ctx.packageName)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      flags = flags or PendingIntent.FLAG_MUTABLE
    }
    return PendingIntent.getBroadcast(ctx, sessionId, intent, flags).intentSender
  }

  // ---------- 结果那条回路：进程级 ----------
  //
  // 为什么整套（接收器 / 终态 / 会话号 / 工作线程）都挂在 companion object 上，也就是**进程级**，
  // 而不是插件实例上：接收器注册在 applicationContext 上、跟着进程活，从不反注册；
  // 而 InstallPlugin 这个实例是**跟着 Activity 走**的——用户改一下系统的字体大小或显示大小，
  // MainActivity 就会重建（gen/android 的 AndroidManifest 里 configChanges 没有 density / fontScale），
  // Tauri 随之新建一个 InstallPlugin。挂在实例上的话：旧实例的接收器仍在、抢到了系统那条终态广播，
  // 把结果写进一个再也没人读的旧字段；前端 install_status 问的是新实例，永远只得到「还没有结果」——
  // 恰好把这次改动唯一想拿到的东西丢掉。放进程级就都对上了，顺带「被系统杀掉重开还答得上来」也更站得住。

  private companion object {
    /** 结果广播的 action。**本包唯一**，接收器又注册成不对外开放，别的应用递不进来 */
    const val RESULT_ACTION = "com.cdpandas.acorn.INSTALL_SESSION_RESULT"

    /** 顺手 trigger 的事件名。现在没人 registerListener，留着是为了将来想改推送时只动一行 */
    const val RESULT_EVENT = "install-result"

    /** 会话里那份 APK 的名字，随便取，只在会话内部用 */
    const val WRITE_NAME = "acorn-update.apk"

    /** 系统说「要用户点一下」，但那个确认页我们没拉起来——自己造的状态码，别跟系统的撞 */
    const val CONFIRM_NOT_LAUNCHED = "CONFIRM_NOT_LAUNCHED"

    /** 此刻没有认账的会话（系统给的会话号一定 >= 0） */
    const val NO_SESSION = -1

    /** 上一次安装会话的终态。广播在主线程写、命令在别的线程读，所以要 @Volatile */
    @Volatile
    var last: JSObject? = null

    /**
     * 这一刻认哪个会话的回执。NO_SESSION = 谁的都不认。
     * 有它才分得清「这一轮的结果」和「上一轮被丢掉的那个会话的临终广播」。
     */
    @Volatile
    var liveSession: Int = NO_SESSION

    /** 运行时注册的结果接收器。整个进程只注册一次，注册在 applicationContext 上（跟着进程活） */
    @Volatile
    var receiver: BroadcastReceiver? = null

    /**
     * 此刻活着的那个插件实例，只为 trigger 用。**弱引用**：接收器是进程级的、永不反注册，
     * 强引用会把 Activity 重建前的那个实例（连同它手里的 Activity）永远留在内存里。
     */
    @Volatile
    var newest: WeakReference<InstallPlugin>? = null

    /**
     * 会话那段活儿跑的地方：开会话、把 13MB 拷进去、fsync、commit（最后一步还是跨进程调用）。
     * 单线程就够——同一时刻只该有一个安装会话，排队反而正好。
     */
    val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
      Thread(r, "acorn-install").apply { isDaemon = true }
    }

    /**
     * 整个进程只注册一次。Android 13 起注册必须显式说明这个接收器不对外开放；
     * 13 以下没有这个参数，裸注册出来的动态接收器**是对外开放的**——action 是个猜得到的常量，
     * 任何应用都能广播它伪造一条终态，界面上就会出现一条假原因（minSdk 24，这段区间是真实存在的）。
     * ContextCompat 这一条两边都对：13 以上传系统的 flag，13 以下自动改用 androidx 那条
     * 签名级权限（<包名>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION，androidx.core 的清单里自带、
     * 已经并进我们的 APK）——只有同一把钥匙签的应用才递得进来，也就是只有橡果自己。
     * 注册可能来自工作线程，所以加锁。
     */
    fun ensureReceiver(ctx: Context) {
      synchronized(InstallPlugin::class.java) {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
          override fun onReceive(context: Context, intent: Intent) {
            onSessionStatus(context, intent)
          }
        }
        ContextCompat.registerReceiver(
          ctx,
          r,
          IntentFilter(RESULT_ACTION),
          ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiver = r
      }
    }

    /** 系统回话了。PENDING_USER_ACTION 要接着把确认页拉起来，其余都是终态 */
    fun onSessionStatus(ctx: Context, intent: Intent) {
      val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
      val id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, NO_SESSION)
      val want = liveSession
      // 会话号那一关。两种要挡掉的：
      //   · 此刻谁都不认（want < 0）：上一轮刚被作废、新会话还没开起来。这时飘回来的
      //     多半就是被我们丢掉的那个会话的 ABORTED——认下来就成了这一轮的假失败原因。
      //   · 号对不上：连点两次时两个会话的 PendingIntent 都活着，各回各的。
      // （极个别 ROM 万一没带会话号：只有正等着结果时才姑且认下，宁可要一个结果也别丢掉它）
      if (want < 0) return
      if (id >= 0 && id != want) return

      var message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
      val other = intent.getStringExtra(PackageInstaller.EXTRA_OTHER_PACKAGE_NAME)
      if (!other.isNullOrEmpty()) {
        message = if (message.isEmpty()) "冲突的包：$other" else "$message（冲突的包：$other）"
      }

      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        // 不是终态：系统要用户亲手点一下「安装」，确认页在 EXTRA_INTENT 里
        val confirm = confirmIntent(intent)
        if (confirm == null) {
          finish(status, CONFIRM_NOT_LAUNCHED, "系统没有给出安装确认页")
          return
        }
        try {
          // 用接收器自己那个 context（就是 applicationContext）拉起来，不碰插件实例手里的 Activity：
          // 那个 Activity 可能早被重建掉了。带 NEW_TASK 才允许从非 Activity 的 context 起页面
          confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          ctx.startActivity(confirm)
        } catch (ex: Exception) {
          finish(status, CONFIRM_NOT_LAUNCHED, ex.toString())
        }
        return
      }

      finish(status, statusName(status), message)
    }

    fun confirmIntent(intent: Intent): Intent? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
      }

    /** 记下终态。前端用 install_status 来取；trigger 那条现在没人听，留着当将来的接口 */
    fun finish(status: Int, code: String, message: String) {
      val out = JSObject()
      out.put("done", true)
      out.put("ok", status == PackageInstaller.STATUS_SUCCESS)
      out.put("status", status)
      out.put("code", code)
      out.put("message", message)
      last = out
      newest?.get()?.trigger(RESULT_EVENT, out)
    }

    /** 状态码的名字原样带给界面：用户截图里有这一行，我们就不用猜是哪一类失败 */
    fun statusName(status: Int): String = when (status) {
      PackageInstaller.STATUS_SUCCESS -> "STATUS_SUCCESS"
      PackageInstaller.STATUS_FAILURE -> "STATUS_FAILURE"
      PackageInstaller.STATUS_FAILURE_ABORTED -> "STATUS_FAILURE_ABORTED"
      PackageInstaller.STATUS_FAILURE_BLOCKED -> "STATUS_FAILURE_BLOCKED"
      PackageInstaller.STATUS_FAILURE_CONFLICT -> "STATUS_FAILURE_CONFLICT"
      PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "STATUS_FAILURE_INCOMPATIBLE"
      PackageInstaller.STATUS_FAILURE_INVALID -> "STATUS_FAILURE_INVALID"
      PackageInstaller.STATUS_FAILURE_STORAGE -> "STATUS_FAILURE_STORAGE"
      PackageInstaller.STATUS_PENDING_USER_ACTION -> "STATUS_PENDING_USER_ACTION"
      else -> "STATUS_$status"
    }
  }

  // ---------- 兜底：老路 ACTION_VIEW ----------

  /**
   * v1.14.1 之前的唯一一条路：FileProvider 出 content:// URI，带上 APK 的 mime 交给系统安装界面。
   * 拉起来就算完，装没装成拿不到。只在会话 API 起不来时才走。
   *
   * 文件必须经 FileProvider 变成 content:// 才递得给别的应用（API 24 起裸 file:// 直接抛
   * FileUriExposedException）。AndroidManifest 里 provider 的 authorities 是 ${applicationId}.fileprovider，
   * res/xml/file_paths.xml 里 <cache-path path="."/> 正好盖住 Tauri 的 app_cache_dir（= getCacheDir）。
   *
   * 用 applicationContext 而不是 Activity 起这个页面：这段现在跑在工作线程上，而
   * Activity.startActivity 在收尾时会去碰窗口的 decor view（cancelInputsAndStartExitTransition），
   * 那是主线程才该干的事。ContextImpl 那条不碰任何 View，只要带上 NEW_TASK 就行（上面已经带了）。
   */
  private fun startViewer(ctx: Context, file: File) {
    val uri: Uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW)
    intent.setDataAndType(uri, "application/vnd.android.package-archive")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    ctx.startActivity(intent)
  }
}
