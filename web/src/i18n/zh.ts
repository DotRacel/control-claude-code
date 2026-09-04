/**
 * zh.ts — the Simplified Chinese catalog, and the source of truth for what keys exist.
 *
 * `MsgKey` is `keyof typeof ZH`, so this file defines the vocabulary and en.ts is typed
 * `Record<MsgKey, string>` — a key added here that nobody translates is a COMPILE ERROR, not a
 * string that silently ships in the wrong language. That is the same trick render/contract.ts
 * plays with `ItemRenderers`, and for the same reason: the failure we care about is the one you
 * cannot see, so it has to be the one that will not build.
 *
 * `{name}` marks a substitution. Values are the app's original copy, moved here verbatim — this
 * file is a relocation, not a rewrite, so the Chinese UI must read exactly as it did before.
 *
 * The copy is deliberately colloquial and second-person ("点右上角的 ?"), because it is talking to
 * one person holding a phone. en.ts matches that register rather than translating word for word.
 */
export const ZH = {
  // ── accessible names (screen readers and, until data-testid landed, test selectors) ──
  'a11y.back': '返回',
  'a11y.more': '更多',
  'a11y.help': '帮助',
  'a11y.logout': '退出登录',
  'a11y.send': '发送',
  'a11y.stop': '停止',
  'a11y.toBottom': '回到底部',
  'a11y.loadImage': '加载图片，{caption}',
  'a11y.toolImage': '工具返回的图片 · {caption}',
  // The open hint is appended to a tool row's label, hence the leading punctuation.
  'a11y.openOutputPhone': '，双击查看输出',
  'a11y.openOutputDesktop': '，点击查看输出',

  // ── auth ──
  'auth.tabLogin': '登录',
  'auth.tabRegister': '注册',
  'auth.pasteToken': '粘贴账号密钥直接连接。',
  'auth.username': '用户名',
  'auth.password': '密码',
  'auth.invite': '邀请码',
  'auth.busy': '请稍候…',
  'auth.registerAndConnect': '注册并连接',
  'auth.connect': '连接',
  'auth.switchToPassword': '用账号密码登录',
  'auth.switchToToken': '使用密钥连接',
  'auth.inviteNote': '注册需要邀请码，向服务器管理员索取。',
  'auth.tokenRejected': '这个密钥无效或已失效',
  'auth.network': '连不上服务器，检查网络后重试',
  'auth.unknown': '出错了，请重试',
  'auth.failed': '请求失败（{status}）',
  // Keyed by the server's own `error.type`, so the phone answers in the reader's language even
  // though the server only ever speaks Chinese. See the precedence note in auth.ts.
  'auth.registrationClosed': '服务端未开放注册',
  'auth.badInviteCode': '邀请码不正确',
  'auth.badUsername': '用户名不符合要求',
  'auth.weakPassword': '密码太短',
  'auth.usernameTaken': '用户名已被占用',
  'auth.badCredentials': '用户名或密码错误',
  'auth.tooManyAttempts': '尝试次数过多，请稍后再试',

  // ── session list / sidebar ──
  'list.title': '会话',
  'list.filterActive': '活跃',
  'list.filterAll': '全部',
  'list.notifyOnApproval': '需要审批时通知我',
  'list.emptyPhone': '还没有会话。点右上角的 ? 看怎么开一个。',
  'list.emptySidebar': '还没有会话。点上面的 ? 看怎么开一个。',
  'list.connecting': '正在连接…',
  'list.logoutTitle': '退出登录？',
  'list.logoutBody': '这台设备会忘掉密钥，下次要重新登录。电脑上的会话不受影响，继续跑。',
  'list.unknownDevice': '未知设备',
  // ── deleting a session (arrived on main while this catalog was being written) ──
  'list.deleteTitle': '删除这个会话？',
  'list.deleteWarning': '「{machine}」的聊天记录会一起删掉，无法恢复。电脑上的 claude 不受影响。',
  'list.delete': '删除',
  'list.deleteSession': '删除会话',
  'a11y.deleteSession': '删除会话 {machine}',
  'list.needsApproval': '需要审批',
  'list.doneWithToolsOne': '完成 · {n} 次工具调用',
  'list.doneWithToolsMany': '完成 · {n} 次工具调用',
  'list.online': '在线',
  'list.offline': '离线',
  'list.runningTool': '运行中 · {tool}',

  // ── relative time on a list row ──
  'time.justNow': '刚刚',
  'time.minutesAgo': '{n} 分钟前',
  'time.hoursAgo': '{n} 小时前',
  'time.daysAgo': '{n} 天前',

  // ── desktop shell / command palette ──
  'desktop.pickSession': '从左边选一个会话',
  'desktop.emptyShell': '还没有会话。左上角的 ? 说明怎么开一个。',
  'switcher.title': '切换会话',
  'switcher.placeholder': '按名字、目录或分支搜索…',
  'switcher.empty': '没有匹配的会话',
  'switcher.toolRunning': '{tool} 运行中',

  // ── chat chrome ──
  'chat.rcSession': 'Remote Control 会话',
  'chat.session': '会话',

  // ── composer ──
  'composer.skill': '技能',
  'composer.slash': '斜杠命令',
  'composer.offline': '离线 — 重连后可继续',
  'composer.busy': '补充说明…',
  'composer.idle': '给 Claude 发消息…',

  // ── activity line ──
  'activity.compacting': '正在压缩上下文…',
  'activity.thinkingTokens': '思考中 · {tokens} tokens',
  'activity.thinking': '思考中',
  'activity.running': '运行中',

  // ── connection banners ──
  'banner.reconnecting': '重新连接中…',
  'banner.stillRunningOn': '会话仍在 {machine} 上继续运行',
  'banner.yourMachine': '你的机器',
  'banner.offline': '已离线',
  'banner.resumeAuto': '恢复连接后会自动继续',
  'banner.retry': '重试',
  'banner.notConnected': '{machine} 上的 claude 没有连着',
  'banner.thisMachine': '这台机器',
  'banner.transcriptKept': '转录仍在，回到终端继续会话即可恢复',

  // ── image attachments ──
  'image.unavailable': '图片已不可用',
  'image.loadFailed': '图片加载失败 · {caption}',
  'image.tapToLoad': '点击加载',
  'image.generic': '图片',

  // ── tool result lines ──
  // Left in English on purpose, in BOTH catalogs: the tool card has always said "Running…" here
  // even in the Chinese UI (tools.ts's own copy rule — present tense, not RUNNING), while the
  // activity line says 运行中. This catalog is a relocation, so that difference is preserved
  // rather than quietly tidied up.
  'tool.running': 'Running…',
  'tool.awaiting': '等待你允许…',
  'tool.failed': '失败',
  'tool.done': '完成',
  // English inflects for number and Chinese does not, so anywhere the count can be 1 gets an
  // explicit One/Many pair and the CALL SITE picks — it already has the number in hand. The
  // alternative was a plural engine in t() for five lines of copy, which is not a trade worth
  // making: "1 matches" is the bug, and a key you can read is the cheapest way to not have it.
  'tool.imageOne': '图片',
  'tool.imageMany': '{n} 张图片',
  'tool.readOne': '读了 {n} 行',
  'tool.readMany': '读了 {n} 行',
  'tool.wroteOne': '写入 {n} 行',
  'tool.wroteMany': '写入 {n} 行',
  'tool.written': '已写入',
  'tool.modified': '已修改',
  'tool.matchOne': '{n} 处结果',
  'tool.matchMany': '{n} 处结果',
  'tool.noMatch': '无匹配',
  'tool.todoList': '任务清单',
  'tool.toolCountOne': '{n} 次工具',
  'tool.toolCountMany': '{n} 次工具',

  // ── to-do list subjects the reducer has to invent ──
  'todo.untitled': '任务',
  'todo.numbered': '任务 #{id}',

  // ── permission surface ──
  'perm.wantsToRun': '{name} 想要执行：',
  'perm.inDir': '在 {cwd}',
  'perm.allowOnce': '允许一次',
  'perm.alwaysAllow': '总是允许',
  'perm.deny': '拒绝',
  'perm.thisDir': '该目录',
  'perm.modalTitle': '需要你的批准',

  // ── tool output surface ──
  'output.empty': '（没有输出）',
  'output.modalTitle': '工具输出',

  // ── session menu ──
  'menu.permMode': '权限模式',
  'menu.current': '当前',
  'menu.renameSession': '重命名会话',
  'menu.nextVersion': '下一版',
  'menu.stopTurn': '停止当前回合',
  'menu.modalTitle': '会话菜单',
  'menu.language': '语言',
  'mode.default': '每次询问',
  'mode.acceptEdits': '自动接受编辑',
  'mode.plan': '计划模式',
  'mode.bypassPermissions': '不再询问',

  // ── language names, each written in its own language (never translated) ──
  'lang.zh': '中文',
  'lang.en': 'English',

  // ── help sheet ──
  'help.modalTitle': '怎么开一个会话',
  'help.meta': '把电脑上的 claude 接到手机',
  'help.step1Title': '在电脑上装好本项目',
  // {code} is a <code> element, substituted by tNode() so the styling survives translation.
  'help.step1Body': '需要 Node ≥ 22 和已经能用的 {code}。',
  'help.step2Title': '用同一个账号登录',
  'help.step2Body': '第一次运行会让你选服务器（填你现在打开的这个地址），再用手机上这个账号登录。答案存在 {config}，之后直接启动；{login} 可以换服务器或账号。',
  'help.step3Title': '在 TUI 里输入 /rc',
  'help.step3Body': '会话立刻出现在这个列表里，之后的对话和工具审批都会推到手机上。',
  // `/rc` is a command and stays literal; the placeholder WORD inside it is prose and does not.
  'help.rcCmd': '/rc\n/rc <会话名>',
  'help.note': '手机不能替你在机器上拉起 claude —— 会话必须从终端开始。终端关掉后会话显示离线，转录仍然留着。',

  // ── confirm sheet ──
  'confirm.cancel': '取消',

  // ── question card ──
  'question.claudeAsks': 'Claude 想问你',
  'question.answered': '已回答',
  'question.handledInTerminal': '已在终端处理',
  'question.freeform': '或者直接写点别的…',
  'question.skip': '跳过',
  'question.submit': '提交',
  'question.skipped': '已跳过',

  // ── plan mode（ExitPlanMode 的批准卡片 + EnterPlanMode 的状态行）──
  'plan.entered': '已进入计划模式 — 只读探索，不改动文件',
  'plan.ready': 'Claude 的实现计划',
  'plan.showFull': '展开完整计划',
  'plan.foldPlan': '收起',
  'plan.feedback': '想让它改什么？（选填，用于「继续规划」）',
  'plan.approve': '批准，开始实现',
  'plan.approveAcceptEdits': '批准，并自动接受编辑',
  'plan.keepPlanning': '继续规划',
  'plan.approved': '已批准',
  'plan.approvedAcceptEdits': '已批准 · 自动接受编辑',
  'plan.rejected': '退回继续规划',
  // 拒绝时没填反馈：模型只知道被拒，这句给它一个方向。
  'plan.rejectedDefault': '先不要开始实现，继续完善这个计划。',
  'plan.modeChip': '计划模式',

  // ── thinking block ──
  'thinking.label': '思考',
  'thinking.collapse': '收起',
  'thinking.expand': '展开',

  // ── background task card ──
  'bgtask.label': '后台任务',
  // English in both catalogs, like tool.running above and for the same reason: this is what the
  // card has always said in the Chinese UI.
  'bgtask.running': 'running…',
  'bgtask.failed': '失败',
  'bgtask.interrupted': '已中断',
  'bgtask.done': '完成',

  // ── a wire shape the transcript has no renderer for yet ──
  'unknown.title': '这条消息的格式还没有适配',
  'unknown.chip': '未适配消息',

  // ── transcript dividers (generated by the reducer) ──
  'divider.reset': '对话已重置',
  'divider.disconnected': '会话已断开',
  'divider.disconnectedWhy': '会话已断开 · {reason}',
  'divider.hostExit': '终端已退出',
  'divider.compacted': '上下文已压缩{why}{size}',
  // The leading separator lives in the value: these are suffixes glued onto the line above, and
  // keeping the " · " here means a translator sees where the fragment actually lands.
  'compact.manual': ' · 手动',
  'compact.auto': ' · 自动',
  'compact.failed': '压缩失败',

  // ── status lines (generated by the reducer) ──
  'status.committed': '已提交',
  'status.pushed': '已推送',
  'status.vcs': '{label}{branch}',
  'status.rateLimit': '{window} · {status}{when}',
  'status.resetsAt': ' · {time} 重置',
  'status.quotaFiveHour': '5 小时额度',
  'status.quota': '额度',

  // ── background task fallback description ──
  'bgtask.untitled': '后台任务',

  // ── aria-live announcements and push bodies ──
  'announce.needsApproval': '需要审批',
  'announce.turnDone': '回合完成',
  'push.needsApproval': '{tool} 需要你的批准',

  // ── copy button ──
  'copy.copy': '复制',
  'copy.copied': '已复制',
  'copy.failed': '复制失败',
} as const;

/** Every key the app is allowed to ask for. en.ts must cover all of them or it will not compile. */
export type MsgKey = keyof typeof ZH;
