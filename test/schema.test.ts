import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// The D1 schema is SQLite: its append-only triggers are tested against the real migration files.
let db: DatabaseSync;
const now = "2026-09-16T12:00:00.000Z";

function seed(moderation: "in_attesa" | "accettata") {
  db.exec(`INSERT INTO reports (id, client_report_id, received_at, channel, category, description, contact, lat, lon, manifest_key, manifest_sha256, moderation)
           VALUES ('R1', 'c1', '${now}', 'pubblico', 'rifiuti', 'testo', 'mail@example.test', 45, 10, 'k', '${"a".repeat(64)}', '${moderation}')`);
  db.exec(`INSERT INTO photos (report_id, idx, sha256, size, mime, origin, captured_at, lat, lon, flags_json, original_key)
           VALUES ('R1', 0, '${"b".repeat(64)}', 10, 'image/jpeg', 'in_app_camera', '${now}', 45, 10, '[]', 'o')`);
  db.exec(`INSERT INTO chain (seq, report_id, manifest_sha256, prev_hash, entry_hash, received_at)
           VALUES (1, 'R1', '${"a".repeat(64)}', '${"0".repeat(64)}', '${"c".repeat(64)}', '${now}')`);
  db.exec(`INSERT INTO audit_log (at, action, report_id) VALUES ('${now}', 'segnalazione_ricevuta', 'R1')`);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
});

describe("evidence is append-only in the database", () => {
  it("blocks rewriting or deleting a chain link", () => {
    seed("accettata");
    expect(() => db.exec(`UPDATE chain SET entry_hash = '${"d".repeat(64)}'`)).toThrow(/sola aggiunta/);
    expect(() => db.exec("DELETE FROM chain")).toThrow(/sola aggiunta/);
  });

  it("still lets the timestamp status of a link be recorded", () => {
    seed("accettata");
    db.exec("UPDATE chain SET tsa_status = 'granted', tsa_key = 'tsa/R1.tsr', tsa_attempts = 1");
    expect(db.prepare("SELECT tsa_status FROM chain").get()).toMatchObject({ tsa_status: "granted" });
  });

  it("blocks editing evidence of an accepted report, but allows workflow status", () => {
    seed("accettata");
    expect(() => db.exec("UPDATE reports SET description = 'altro'")).toThrow(/probatori/);
    expect(() => db.exec("UPDATE reports SET lat = 1")).toThrow(/probatori/);
    expect(() => db.exec("UPDATE photos SET sha256 = 'x'")).toThrow(/non si modificano/);
    expect(() => db.exec("DELETE FROM reports")).toThrow(/non si cancellano/);
    db.exec("UPDATE reports SET status = 'inviata', status_note = 'prot. 1'");
    expect(db.prepare("SELECT status FROM reports").get()).toMatchObject({ status: "inviata" });
  });

  it("allows wiping content only when rejecting a quarantined report, photos first", () => {
    seed("in_attesa");
    db.exec("UPDATE photos SET removed = 1, exif_json = NULL, lat = NULL, lon = NULL WHERE report_id = 'R1'");
    db.exec("UPDATE reports SET moderation = 'rifiutata', description = '', contact = NULL, lat = NULL, lon = NULL WHERE id = 'R1'");
    expect(db.prepare("SELECT description, contact FROM reports").get()).toMatchObject({ description: "", contact: null });
    // The link survives the rejection.
    expect(db.prepare("SELECT COUNT(*) AS n FROM chain").get()).toMatchObject({ n: 1 });
  });

  it("does not allow wiping an accepted report", () => {
    seed("accettata");
    expect(() => db.exec("UPDATE photos SET removed = 1 WHERE report_id = 'R1'")).toThrow(/non si modificano/);
    expect(() => db.exec("UPDATE reports SET moderation = 'rifiutata', description = ''")).toThrow();
  });

  it("aborts a rejection that races an acceptance committed first", () => {
    seed("in_attesa");
    db.exec("UPDATE reports SET moderation = 'accettata' WHERE moderation = 'in_attesa'");
    // The rejection batch starts with the photos: the trigger refuses once the report is no longer pending.
    expect(() => db.exec("UPDATE photos SET removed = 1, exif_json = NULL WHERE report_id = 'R1'")).toThrow(/non si modificano/);
    expect(db.prepare("SELECT removed FROM photos").get()).toMatchObject({ removed: 0 });
  });

  it("lets an accepted report's files move to the archive", () => {
    seed("accettata");
    db.exec("UPDATE photos SET original_key = 'originals/R1/1.jpg', derived_key = NULL");
    db.exec("UPDATE reports SET manifest_key = 'manifests/R1.json'");
    expect(db.prepare("SELECT manifest_key FROM reports").get()).toMatchObject({ manifest_key: "manifests/R1.json" });
  });

  it("makes a moderation decision final", () => {
    seed("in_attesa");
    db.exec("UPDATE reports SET moderation = 'accettata'");
    expect(() => db.exec("UPDATE reports SET moderation = 'rifiutata'")).toThrow(/non si cambia/);
  });

  it("keeps the audit log append-only", () => {
    seed("accettata");
    expect(() => db.exec("UPDATE audit_log SET action = 'x'")).toThrow(/sola aggiunta/);
    expect(() => db.exec("DELETE FROM audit_log")).toThrow(/sola aggiunta/);
  });

  it("rejects a second link with the same sequence number (concurrent append)", () => {
    seed("accettata");
    db.exec(`INSERT INTO reports (id, client_report_id, received_at, channel, category, description, manifest_key, manifest_sha256, moderation)
             VALUES ('R2', 'c2', '${now}', 'pubblico', 'rifiuti', 't', 'k', '${"e".repeat(64)}', 'in_attesa')`);
    expect(() =>
      db.exec(`INSERT INTO chain (seq, report_id, manifest_sha256, prev_hash, entry_hash, received_at) VALUES (1, 'R2', '${"e".repeat(64)}', '${"c".repeat(64)}', '${"f".repeat(64)}', '${now}')`),
    ).toThrow(/UNIQUE|PRIMARY/);
  });
});
