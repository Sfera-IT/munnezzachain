// Creates (or resets) an administrator directly in D1.
// Usage: node scripts/create-admin.ts <email-o-utente> "<Nome Cognome>" [--local]
// Without ADMIN_PASSWORD a temporary password is generated and must be changed at first login.
// With ADMIN_PASSWORD (read from the environment, never from argv or the repo) that password is kept.
import { execFileSync } from "node:child_process";
import { generatePassword, hashPassword } from "../src/shared/password.ts";

const [email, name] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const local = process.argv.includes("--local");
if (!email || !name) {
  console.error('Uso: node scripts/create-admin.ts <email> "<Nome Cognome>" [--local]');
  process.exit(1);
}
const chosen = process.env.ADMIN_PASSWORD;
if (chosen !== undefined && chosen.length < 12) {
  console.error("ADMIN_PASSWORD deve avere almeno 12 caratteri");
  process.exit(1);
}
const password = chosen ?? generatePassword();
const mustChange = chosen ? 0 : 1;
const hash = await hashPassword(password);
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sql = `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at)
VALUES (${q(crypto.randomUUID())}, ${q(email.toLowerCase())}, ${q(name)}, 'admin', ${q(hash)}, 1, ${mustChange}, ${q(new Date().toISOString())})
ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = excluded.password_hash, active = 1, must_change_password = ${mustChange};`;
execFileSync("npx", ["wrangler", "d1", "execute", "munnezzachain", local ? "--local" : "--remote", "--command", sql], { stdio: ["ignore", "ignore", "inherit"] });
console.log(
  chosen
    ? `\nAmministratore ${email} pronto (${local ? "locale" : "produzione"}), con la password indicata.`
    : `\nAmministratore ${email} pronto (${local ? "locale" : "produzione"}).\nPassword provvisoria, da cambiare al primo accesso:\n\n  ${password}\n`,
);
