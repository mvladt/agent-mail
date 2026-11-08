import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Мониторинг agent-mail для агента.
 *
 * Читает неподтверждённые письма из MAIL_ROOT/mailbox/<AGENT_NAME>/msg-*.md
 * и доставляет их в контекст сессии через pi.sendMessage(triggerTurn).
 * Read-only: не отправляет и не подтверждает письма (done — явный шаг агента).
 *
 * Env: MAIL_ROOT (по умолчанию ~/.agent-mail), AGENT_NAME (обязателен),
 *      AGENT_MAIL_INTERVAL_MS (по умолчанию 10000) — для тестов и тюнинга.
 */

const MAIL_ROOT = process.env.MAIL_ROOT || path.join(os.homedir(), ".agent-mail");
const INTERVAL_MS = parseInt(process.env.AGENT_MAIL_INTERVAL_MS || "10000", 10);

function isValidName(name: string | undefined): name is string {
  return !!name && name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let sessionCtx: any = null;
  let shuttingDown = false;
  const seen = new Set<string>();

  function listMail(inbox: string): string[] {
    try {
      return fs.readdirSync(inbox).filter((f) => f.startsWith("msg-") && f.endsWith(".md"));
    } catch {
      return []; // каталога нет — 0 писем, не ошибка
    }
  }

  // Синхронный readdir/readFile: не может перекрыться с другим вызовом,
  // поэтому отдельный in-flight guard не нужен.
  function deliver() {
    if (shuttingDown) return;
    const name = process.env.AGENT_NAME;
    if (!isValidName(name)) return;

    const inbox = path.join(MAIL_ROOT, "mailbox", name);
    const fresh = listMail(inbox).filter((f) => !seen.has(f));
    if (fresh.length === 0) return;

    const bodies = fresh.map((f) => {
      const content = fs.readFileSync(path.join(inbox, f), "utf8");
      return `ID: ${f}\n${content}`;
    });

    try {
      pi.sendMessage(
        {
          customType: "agent-mail",
          content:
            `Входящее письмо (${fresh.length}):\n\n${bodies.join("\n\n---\n\n")}\n\n` +
            `После обработки подтверди получение: agent-mail done <ID>`,
          display: true,
        },
        { triggerTurn: true },
      );
      // seen — только после успешного sendMessage
      for (const f of fresh) seen.add(f);
    } catch {
      // при ошибке не помечаем seen: письмо доставится следующей попыткой
    }
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionCtx = ctx;
    shuttingDown = false;

    const name = process.env.AGENT_NAME;
    if (!isValidName(name)) {
      if (ctx.hasUI) ctx.ui.notify("agent-mail: не задан AGENT_NAME — мониторинг выключен", "warning");
      return;
    }

    deliver(); // catch-up

    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (shuttingDown) return;
      let idle = true;
      try {
        idle = !!sessionCtx?.isIdle?.();
      } catch {
        idle = true;
      }
      if (idle) deliver();
      // иначе письмо подхватит agent_settled на границе турна
    }, INTERVAL_MS);
  });

  pi.on("agent_settled", async () => {
    deliver();
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
