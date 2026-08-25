/**
 * en.ts — the English catalog, and the fallback for every locale that is not Chinese.
 *
 * Typed `Record<MsgKey, string>` against zh.ts, so this file cannot be missing a key: adding copy
 * to the catalog without translating it fails the build instead of shipping Chinese to an English
 * reader. Do not loosen that type to `Partial`.
 *
 * The Chinese copy is warm, colloquial and second-person — it talks to one person holding a phone,
 * not to a user of an enterprise console. These strings match that register rather than
 * translating word for word: "点右上角的 ?" becomes "Tap the ? in the top right", not "Please
 * consult the help affordance". Where Chinese uses an em-dash aside, so does this.
 */
import type { MsgKey } from './zh.ts';

export const EN: Record<MsgKey, string> = {
  // ── accessible names ──
  'a11y.back': 'Back',
  'a11y.more': 'More',
  'a11y.help': 'Help',
  'a11y.logout': 'Sign out',
  'a11y.send': 'Send',
  'a11y.stop': 'Stop',
  'a11y.toBottom': 'Back to bottom',
  'a11y.loadImage': 'Load image, {caption}',
  'a11y.toolImage': 'Image returned by a tool · {caption}',
  'a11y.openOutputPhone': ', double-tap to see the output',
  'a11y.openOutputDesktop': ', click to see the output',

  // ── auth ──
  'auth.tabLogin': 'Sign in',
  'auth.tabRegister': 'Register',
  'auth.pasteToken': 'Paste your account key to connect directly.',
  'auth.username': 'Username',
  'auth.password': 'Password',
  'auth.invite': 'Invite code',
  'auth.busy': 'One moment…',
  'auth.registerAndConnect': 'Register and connect',
  'auth.connect': 'Connect',
  'auth.switchToPassword': 'Sign in with a username instead',
  'auth.switchToToken': 'Connect with a key instead',
  'auth.inviteNote': 'Registering needs an invite code — ask whoever runs the server.',
  'auth.tokenRejected': 'That key is invalid or has expired',
  'auth.network': 'Cannot reach the server — check your connection and try again',
  'auth.unknown': 'Something went wrong. Try again.',
  'auth.failed': 'Request failed ({status})',
  'auth.registrationClosed': 'This server is not open for registration',
  'auth.badInviteCode': 'That invite code is not right',
  'auth.badUsername': 'That username is not allowed',
  'auth.weakPassword': 'That password is too short',
  'auth.usernameTaken': 'That username is taken',
  'auth.badCredentials': 'Wrong username or password',
  'auth.tooManyAttempts': 'Too many attempts. Try again in a bit.',

  // ── session list / sidebar ──
  'list.title': 'Sessions',
  'list.filterActive': 'Active',
  'list.filterAll': 'All',
  'list.notifyOnApproval': 'Notify me when something needs approval',
  'list.emptyPhone': 'No sessions yet. Tap the ? in the top right to see how to start one.',
  'list.emptySidebar': 'No sessions yet. Tap the ? above to see how to start one.',
  'list.connecting': 'Connecting…',
  'list.logoutTitle': 'Sign out?',
  'list.logoutBody': 'This device will forget your key, so you will sign in again next time. Sessions on your computer are untouched and keep running.',
  'list.unknownDevice': 'Unknown device',
  'list.deleteTitle': 'Delete this session?',
  'list.deleteWarning': 'The transcript for “{machine}” goes with it, and cannot be recovered. The claude on your computer is unaffected.',
  'list.delete': 'Delete',
  'list.deleteSession': 'Delete session',
  'a11y.deleteSession': 'Delete session {machine}',
  'list.needsApproval': 'Needs approval',
  'list.doneWithToolsOne': 'Done · {n} tool call',
  'list.doneWithToolsMany': 'Done · {n} tool calls',
  'list.online': 'Online',
  'list.offline': 'Offline',
  'list.runningTool': 'Running · {tool}',

  // ── relative time ──
  // Abbreviated on purpose: these sit in a narrow list row, and "min"/"hr"/"d" read correctly at
  // 1 as well as 12, which spares four more One/Many pairs.
  'time.justNow': 'just now',
  'time.minutesAgo': '{n} min ago',
  'time.hoursAgo': '{n} hr ago',
  'time.daysAgo': '{n} d ago',

  // ── desktop shell / command palette ──
  'desktop.pickSession': 'Pick a session on the left',
  'desktop.emptyShell': 'No sessions yet. The ? in the top left explains how to start one.',
  'switcher.title': 'Switch session',
  'switcher.placeholder': 'Search by name, directory or branch…',
  'switcher.empty': 'No matching sessions',
  'switcher.toolRunning': '{tool} running',

  // ── chat chrome ──
  'chat.rcSession': 'Remote Control session',
  'chat.session': 'Session',

  // ── composer ──
  'composer.skill': 'Skill',
  'composer.slash': 'Slash command',
  'composer.offline': 'Offline — carry on once reconnected',
  'composer.busy': 'Add to this…',
  'composer.idle': 'Message Claude…',

  // ── activity line ──
  'activity.compacting': 'Compacting context…',
  'activity.thinkingTokens': 'Thinking · {tokens} tokens',
  'activity.thinking': 'Thinking',
  'activity.running': 'Running',

  // ── connection banners ──
  'banner.reconnecting': 'Reconnecting…',
  'banner.stillRunningOn': 'The session is still running on {machine}',
  'banner.yourMachine': 'your machine',
  'banner.offline': 'Offline',
  'banner.resumeAuto': 'It picks up again on its own once you reconnect',
  'banner.retry': 'Retry',
  'banner.notConnected': 'claude on {machine} is not connected',
  'banner.thisMachine': 'this machine',
  'banner.transcriptKept': 'The transcript is still here — go back to the terminal to resume the session',

  // ── image attachments ──
  'image.unavailable': 'Image no longer available',
  'image.loadFailed': 'Image failed to load · {caption}',
  'image.tapToLoad': 'Tap to load',
  'image.generic': 'Image',

  // ── tool result lines ──
  'tool.running': 'Running…',
  'tool.awaiting': 'Waiting for you to allow it…',
  'tool.failed': 'Failed',
  'tool.done': 'Done',
  'tool.imageOne': 'Image',
  'tool.imageMany': '{n} images',
  'tool.readOne': 'Read {n} line',
  'tool.readMany': 'Read {n} lines',
  'tool.wroteOne': 'Wrote {n} line',
  'tool.wroteMany': 'Wrote {n} lines',
  'tool.written': 'Written',
  'tool.modified': 'Modified',
  'tool.matchOne': '{n} match',
  'tool.matchMany': '{n} matches',
  'tool.noMatch': 'No matches',
  'tool.todoList': 'To-do list',
  'tool.toolCountOne': '{n} tool',
  'tool.toolCountMany': '{n} tools',

  // ── to-do subjects ──
  'todo.untitled': 'Task',
  'todo.numbered': 'Task #{id}',

  // ── permission surface ──
  'perm.wantsToRun': '{name} wants to run:',
  'perm.inDir': 'in {cwd}',
  'perm.allowOnce': 'Allow once',
  'perm.alwaysAllow': 'Always allow',
  'perm.deny': 'Deny',
  'perm.thisDir': 'this directory',
  'perm.modalTitle': 'Needs your approval',

  // ── tool output surface ──
  'output.empty': '(no output)',
  'output.modalTitle': 'Tool output',

  // ── session menu ──
  'menu.permMode': 'Permission mode',
  'menu.current': 'Current',
  'menu.renameSession': 'Rename session',
  'menu.nextVersion': 'Next version',
  'menu.stopTurn': 'Stop this turn',
  'menu.modalTitle': 'Session menu',
  'menu.language': 'Language',
  'mode.default': 'Ask every time',
  'mode.acceptEdits': 'Auto-accept edits',
  'mode.plan': 'Plan mode',
  'mode.bypassPermissions': 'Never ask',

  // ── language names stay in their own language ──
  'lang.zh': '中文',
  'lang.en': 'English',

  // ── help sheet ──
  'help.modalTitle': 'How to start a session',
  'help.meta': 'Connect the claude on your computer to your phone',
  'help.step1Title': 'Install this project on your computer',
  'help.step1Body': 'Needs Node ≥ 22 and a {code} that already works.',
  'help.step2Title': 'Sign in with the same account',
  'help.step2Body': 'The first run asks you to pick a server (enter the address you have open right now), then to sign in with this same account. Your answers live in {config} and it starts straight up after that; {login} switches server or account.',
  'help.step3Title': 'Type /rc in the TUI',
  'help.step3Body': 'The session shows up in this list immediately, and from then on the conversation and every tool approval get pushed to your phone.',
  'help.rcCmd': '/rc\n/rc <session-name>',
  'help.note': 'Your phone cannot start claude on the machine for you — a session has to begin in the terminal. Close the terminal and the session reads as offline, but the transcript stays.',

  // ── confirm sheet ──
  'confirm.cancel': 'Cancel',

  // ── question card ──
  'question.claudeAsks': 'Claude has a question',
  'question.answered': 'Answered',
  'question.handledInTerminal': 'Handled in the terminal',
  'question.freeform': 'Or just write something else…',
  'question.skip': 'Skip',
  'question.submit': 'Submit',
  'question.skipped': 'Skipped',

  // ── thinking block ──
  'thinking.label': 'Thinking',
  'thinking.collapse': 'collapse',
  'thinking.expand': 'expand',

  // ── background task card ──
  'bgtask.label': 'Background task',
  'bgtask.running': 'running…',
  'bgtask.failed': 'Failed',
  'bgtask.interrupted': 'Interrupted',
  'bgtask.done': 'Done',

  // ── unrendered wire shape ──
  'unknown.title': 'This message shape is not supported yet',
  'unknown.chip': 'Unsupported message',

  // ── transcript dividers ──
  'divider.reset': 'Conversation reset',
  'divider.disconnected': 'Session disconnected',
  'divider.disconnectedWhy': 'Session disconnected · {reason}',
  'divider.hostExit': 'terminal exited',
  'divider.compacted': 'Context compacted{why}{size}',
  'compact.manual': ' · manual',
  'compact.auto': ' · auto',
  'compact.failed': 'Compaction failed',

  // ── status lines ──
  'status.committed': 'Committed',
  'status.pushed': 'Pushed',
  'status.vcs': '{label}{branch}',
  'status.rateLimit': '{window} · {status}{when}',
  'status.resetsAt': ' · resets {time}',
  'status.quotaFiveHour': '5-hour quota',
  'status.quota': 'Quota',

  // ── background task fallback ──
  'bgtask.untitled': 'Background task',

  // ── announcements and push bodies ──
  'announce.needsApproval': 'Needs approval',
  'announce.turnDone': 'Turn complete',
  'push.needsApproval': '{tool} needs your approval',

  // ── copy button ──
  'copy.copy': 'Copy',
  'copy.copied': 'Copied',
  'copy.failed': 'Copy failed',
};
