# App lock

The app lock asks for a master password before HuginnDB shows anything. It is
off until you turn it on in **Settings → Security**.

## What it protects against

Someone who sits down at your computer while your Windows session is open:
a colleague while you are at the coffee machine, or a laptop left unlocked in
a meeting room.

With the lock on, that person:

- **cannot open HuginnDB.** The app shows only the lock screen. Your
  connections, tabs, the schema tree and the AI panel are not loaded until you
  unlock.
- **cannot find your passwords in Windows.** Turning the lock on moves every
  secret HuginnDB stores out of the system keychain (the Windows Credential
  Manager) and into an encrypted vault. Only the master password opens it.
  That covers connection passwords, SSH passwords and passphrases, the
  passphrases of shared origins, the AI panel's API key and the issue
  reporter's GitHub token.
- **cannot use the MCP connector.** Claude Desktop, Cursor and other clients
  get the answer *"HuginnDB is locked: open the HuginnDB app and unlock it"*
  until you do. The connector has no way to unlock the vault on its own.
- **gains nothing by deleting HuginnDB's files.** The secrets are in the
  vault, not in the files, so removing the vault or the settings leaves an
  app with no passwords rather than an app with no lock.

## What it does not protect against

Say this plainly to anyone who relies on it:

- **Malware, a keylogger, or someone with prolonged access to your account.**
  Software that runs as you can record the master password as you type it,
  or read memory while HuginnDB is unlocked.
- **Files on disk that are not secrets.** Connection names and hosts
  (`profiles.json`), the queries in your restored tabs (`tab_state.json`),
  query history and Pulse's history are still stored unencrypted. Someone who
  can read your user folder can read them. Encrypting them is planned for a
  later version.
- **Connections that need no password.** A SQLite file, or a server that
  trusts your machine, needs no secret, so anyone who can reach the file or
  the server can open it with another tool.
- **Anyone who already has the database password.** They can use any other
  client.

## Turning it on

1. Open **Settings → Security** and choose **Turn on the app lock…**.
2. Choose a master password of at least 12 characters. A few unrelated words
   with spaces between them are easier to remember than a short password full
   of symbols, and harder to guess.
3. Confirm that you understand the warning below. HuginnDB then moves your
   secrets into the vault and tells you how many it moved.

> **If you forget the master password, nobody can recover the secrets in the
> vault — not even HuginnDB.** Your connections are kept, but you will have to
> type every password again.

## When it locks

- Every time HuginnDB starts.
- After a period without a key press, click or scroll in any HuginnDB window:
  15 minutes by default. Change it, or turn it off, under **Lock after
  inactivity**.
- When your computer's session locks: **Win+L**, the screen saver's lock, or
  disconnecting from a Remote Desktop session (closing the client leaves the
  session running on the server). On Linux, when the desktop locks the
  session through logind, as GNOME and KDE do. Turn it off with **Lock with
  the session**.
- When you press **Ctrl+L** (or choose **Lock now** in Settings). The shortcut
  can be changed in **Settings → Shortcuts**.

When it locks, every window except the main one closes, every database
connection and SSH tunnel is closed, and the AI panel's conversation is
cleared. Unlocking does not reconnect anything: you open what you need again.

## Wrong passwords

After three wrong attempts in a row, HuginnDB makes you wait before the next
one: two seconds at first, doubling each time, up to five minutes. This slows
down someone guessing at the lock screen. It does not protect a copy of the
vault file taken off the machine: there, only the length of your master
password and the cost of checking it (Argon2id, a third of a second or so per
guess) stand in the way. That is why a long password matters more than a
complicated one.

## Forgot the master password

On the lock screen, choose **Forgot your master password?**. You can reset the
vault:

- every secret in it is deleted, and cannot be recovered;
- your connections, environments and settings stay as they are;
- you choose a new master password, and the lock stays on;
- each connection asks for its password the next time you connect.

HuginnDB shows the same screen if its vault file is missing or damaged.

## Changing the password, or turning the lock off

In **Settings → Security**:

- **Change master password…** asks for the current password and a new one.
  Your secrets are not touched.
- **Turn off…** asks for the master password and puts every secret back in the
  system keychain, exactly as it was before.

## On a managed computer

Your organization's HuginnDB policy can require the lock, limit how long
HuginnDB may sit idle, and decide whether it locks with your session. Those
settings then show who decides them, and HuginnDB applies them even where the
interface would let you change them. See [Managed policy](POLICY.md).

## Related

- [Connections](CONNECTIONS.md): how passwords are stored when the lock is off.
- [MCP connector](MCP.md): what the connector can reach.
