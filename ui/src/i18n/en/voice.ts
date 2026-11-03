/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Voice input in the message box (spec 2026-10-22-005 §3-10, §3-10-1)
export default {
  'voice.label': 'Voice input',
  'voice.finishLabel': 'Finish recording',
  'voice.cancelRecording': 'Cancel recording',
  'voice.cancelTranscribe': 'Cancel transcription',
  'voice.tooltip': 'Voice input · up to 1 minute · recordings are not stored',
  'voice.blocked': 'Voice input is unavailable because the AI Agent Workspace is not connected',
  'voice.blockedMine': 'Voice input is unavailable because your AI Agent Workspace is not connected',
  'voice.otherWindow': 'Recording in another window',
  'voice.asking': 'Allow the microphone in the browser prompt',
  'voice.denied': 'Allow the microphone from the site information icon at the left of the address bar',
  'voice.notFound': 'No microphone found',
  'voice.inUse': 'Another program is using the microphone',
  'voice.micError': 'Could not open the microphone',
  'voice.silent': 'No sound detected. Check your microphone',
  'voice.tenLeft': '10 seconds left',
  'voice.autoStopped': 'Recording stopped at 1 minute',
  'voice.recording': 'Recording',
  'voice.transcribing': 'Transcribing…',
  'voice.empty': 'No speech recognized',
  'voice.hint': 'Check the transcribed text and press Enter to send',
  'voice.busy': 'Transcription is busy right now. Select retry',
  'voice.failed': 'Could not transcribe. Select retry',
  'voice.failedFinal': 'Could not transcribe',
  'voice.tooLong': 'The recording is too long. Speak in shorter parts',
  'voice.waitConnection': 'The AI Agent Workspace connection was lost. Select retry once it reconnects',
  'voice.failedShort': 'Transcription failed',
  'voice.retry': 'Retry',
  'voice.dismiss': 'Discard recording',
  'voice.sendBlocked': 'You can send after transcription finishes',
  'voice.started': 'Recording started',
  'voice.stopped': 'Recording finished. Transcribing',
  'voice.discarded': 'Recording discarded',
  'voice.inserted': 'Transcribed text added to the message box. Check it and press Enter to send',
  // Live (streaming) transcription (OMAI-1554, spec 2026-10-31-001 D21-D24)
  'voice.tooltipStream': 'Voice input · up to {min} min · recordings are not stored',
  'voice.autoStoppedAt': 'Recording stopped at the maximum length ({time})',
  'voice.streamBusy': 'Live transcription is busy. The recording will be transcribed when you finish',
  'voice.finishing': 'Finishing…',
  'voice.recovering': 'Connection lost. Finishing the transcription…',
  'voice.loginRequired': 'Your session ended. Sign in again',
  'voice.forbidden': 'Voice input is not available for this AI Agent Workspace',
  // Second pass (spec 2026-11-01-001 D12, D13, D18, D19)
  'voice.refining': 'Refining…',
  'voice.refined': 'Transcript refined',
  'voice.undo': 'Undo',
  'voice.refinedInserted': 'Transcript refined. Check it and press Enter to send',
} as Record<string, string>;
