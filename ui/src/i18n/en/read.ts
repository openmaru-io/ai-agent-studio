/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Read answers aloud (spec 2026-10-28-012 §3-9, §3-9-1)
export default {
  'read.label': 'Read aloud',
  'read.preparing': 'Getting ready to read · press to cancel',
  'read.stop': 'Stop reading',
  'read.slow': 'Getting ready…',
  'read.truncatedShort': 'Reading only the first 15 minutes or so',
  'read.emptyShort': 'Nothing to read',
  'read.failedShort': 'Could not read this aloud',
  'read.busyShort': 'Too many read requests right now',
  'read.retry': 'Try again',
  'read.recording': 'Cannot read aloud while recording',
  'read.streaming': 'Available once the answer is finished',
  'read.band': 'Reading the answer from {name}',
  'read.bandGo': 'Go to the answer from {name}',
  'read.bandStop': 'Stop',
  'read.started': 'Reading started',
  'read.finished': 'Finished reading',
  'read.failed': 'Could not read this aloud',
  'read.busy': 'Too many read requests right now',
  'read.truncated': 'Reading only the first 15 minutes or so',
  'read.empty': 'Nothing to read',
  'read.voice': 'Read-aloud voice',
  'read.voiceHelp': 'Used by [Read aloud] under answers',
  'read.preview': 'Preview',
  'read.previewStop': 'Stop preview',
  'read.female': 'Female',
  'read.male': 'Male',
} as Record<string, string>;
