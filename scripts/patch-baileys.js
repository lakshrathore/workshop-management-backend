// Runs after `npm install` (package.json "postinstall").
//
// Patches a bug in @whiskeysockets/baileys 7.0.0-rc14: when a recipient's phone
// asks for a message to be resent (it couldn't decrypt it), Baileys encrypts the
// resend twice — once in the normal device fan-out and again in the retry block.
// WhatsApp rejects that stanza with "smax-invalid (479)" and the message is never
// delivered (single tick). Upstream: issue #2781, draft PR #2839.
//
// Fix (same as the PR): don't put the retry device into the fan-out list, and
// make sure a session exists before the single retry encryption.
//
// Safe to run repeatedly. If Baileys changes and the code isn't found, it only
// prints a warning — it never fails the install.

const fs = require('fs');
const path = require('path');

// Optional argument: a file path to patch instead (used for testing on a copy).
const file = process.argv[2] || path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'messages-send.js');
const MARK = '/* moji-patch: retry-resend-single-encrypt */';

const patches = [
  {
    // 1. Retry device must not join the normal fan-out (that was the 1st encryption).
    find: `            const { user, device } = jidDecode(participant.jid);
            devices.push({
                user,
                device,
                jid: participant.jid
            });
        }`,
    replace: `            ${MARK}
        }`,
  },
  {
    // 2. The retry block now does the only encryption — ensure a session first.
    find: `            if (isRetryResend) {
                const isParticipantLid = isLidUser(participant.jid);`,
    replace: `            if (isRetryResend) {
                await assertSessions([participant.jid]);
                const isParticipantLid = isLidUser(participant.jid);`,
  },
];

try {
  if (!fs.existsSync(file)) {
    console.warn('[patch-baileys] Baileys not installed — skipped');
    process.exit(0);
  }
  let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (src.includes(MARK)) {
    console.log('[patch-baileys] already patched');
    process.exit(0);
  }
  const missing = patches.filter((p) => !src.includes(p.find));
  if (missing.length) {
    console.warn(`[patch-baileys] code not found (Baileys version changed?) — NOT patched. Check issue #2781 is fixed upstream.`);
    process.exit(0);
  }
  for (const p of patches) src = src.replace(p.find, p.replace);
  fs.writeFileSync(file, src);
  console.log('[patch-baileys] applied retry-resend fix (Baileys issue #2781)');
} catch (err) {
  console.warn('[patch-baileys] failed, continuing without it:', err.message);
}
