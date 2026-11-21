/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Linking my messenger account, pending link requests, restart (spec 2026-11-17-008 §5)
export default {
  'messenger.linkButton': 'Link my messenger account',
  'messenger.linkedCount': '{n} messenger(s) linked',
  'messenger.title': 'Link my messenger account',
  'messenger.help': 'Send any message to this AI agent\'s bot in your messenger and it replies with an 8-character link code. Enter that code below.',
  'messenger.which': 'Messenger to link',
  'messenger.hint.telegram': 'In Telegram, search for the bot name or open the t.me link the owner gave you.',
  'messenger.hint.slack': 'In Slack, search for the app name and send it a message. If there is no message box, ask the owner to turn on the app\'s Messages tab.',
  'messenger.hint.discord': 'In Discord you must share a server with the bot to message it.',
  'messenger.hint.mattermost': 'In Mattermost the bot account must be on your team to appear in the direct message search.',
  'messenger.botOff': 'This bot is not connected right now. If you get no code, tell the owner.',
  'messenger.noBot': '{name} has not connected a messenger to this AI agent yet. Ask the owner to connect one.',
  'messenger.code': 'Link code',
  'messenger.link': 'Link',
  'messenger.linked': '{name} is linked. If this is not your account, remove it right away.',
  'messenger.noDelivery': 'This messenger can chat but cannot receive notifications.',
  'messenger.mine': 'Messengers I linked',
  'messenger.unlink': 'Remove',
  'messenger.whoIs': 'Who is {name}',
  'messenger.whoUnknown': 'Not chosen',
  'messenger.linkedBy': 'linked by {name}',
  'messenger.notAasUser': 'not an AAS user',
  'messenger.clearPending': 'Clear pending requests',
  'messenger.inboxLinked': 'Messenger account linked',
  'messenger.inboxLinkedText': '{member} linked {platform} account {user} to {profile}.',
  'messenger.notifyMe': 'Also get approval and failed scheduled job notifications in my messenger',
  'messenger.team': 'Team notice chat',
  'messenger.teamOff': 'Do not send',
  'messenger.teamHelp': 'Also sends failed scheduled jobs to this bot\'s home channel (team group). Send /sethome in the group to set it.',
  'messenger.teamSaved': 'Changed the team notice chat.',
  'messenger.sentToo': 'Also sent to messenger',
} as Record<string, string>;
