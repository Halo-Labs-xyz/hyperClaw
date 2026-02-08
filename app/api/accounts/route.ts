import { NextResponse } from "next/server";
import {
  listAccounts,
  addAccount,
  removeAccount,
  setDefaultAccount,
  linkAccountToAgent,
} from "@/lib/account-manager";

/**
 * GET /api/accounts - List all accounts
 */
export async function GET() {
  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch (error) {
    console.error("List accounts error:", error);
    return NextResponse.json(
      { error: "Failed to list accounts" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/accounts - Add, remove, set-default, or link account
 *
 * Body:
 *   { action: "add", alias, privateKey?, address?, isDefault?, agentId? }
 *   { action: "remove", alias }
 *   { action: "set-default", alias }
 *   { action: "link", alias, agentId }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    switch (body.action) {
      case "add": {
        if (!body.alias) {
          return NextResponse.json(
            { error: "alias required" },
            { status: 400 }
          );
        }
        const account = await addAccount({
          alias: body.alias,
          privateKey: body.privateKey,
          address: body.address,
          isDefault: body.isDefault,
          agentId: body.agentId,
        });
        // Strip encrypted key from response
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { encryptedKey, ...safe } = account;
        return NextResponse.json({ account: safe }, { status: 201 });
      }

      case "remove": {
        if (!body.alias) {
          return NextResponse.json(
            { error: "alias required" },
            { status: 400 }
          );
        }
        await removeAccount(body.alias);
        return NextResponse.json({ success: true });
      }

      case "set-default": {
        if (!body.alias) {
          return NextResponse.json(
            { error: "alias required" },
            { status: 400 }
          );
        }
        await setDefaultAccount(body.alias);
        return NextResponse.json({ success: true });
      }

      case "link": {
        if (!body.alias || !body.agentId) {
          return NextResponse.json(
            { error: "alias and agentId required" },
            { status: 400 }
          );
        }
        await linkAccountToAgent(body.alias, body.agentId);
        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action. Use: add, remove, set-default, link" },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error("Account action error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Account action failed" },
      { status: 500 }
    );
  }
}
