/**
 * GET /api/unibase/poll
 * 
 * Gateway polling endpoint for POLLING mode agents.
 * Agents call this endpoint periodically to fetch queued tasks.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  pollGatewayTasks,
  submitTaskResult,
  invokeAIPAgent,
} from "@/lib/unibase-aip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PollRequest {
  agent_id: string;
}

export async function POST(req: NextRequest) {
  try {
    const body: PollRequest = await req.json();
    const { agent_id } = body;

    if (!agent_id) {
      return NextResponse.json(
        { error: "agent_id is required" },
        { status: 400 }
      );
    }

    // Poll for tasks
    const tasks = await pollGatewayTasks(agent_id);

    // Process tasks
    const results = [];
    for (const task of tasks) {
      try {
        const response = await invokeAIPAgent(agent_id, task.context);
        await submitTaskResult(task.task_id, response);
        
        results.push({
          task_id: task.task_id,
          success: true,
          response: response.content,
        });
      } catch (error) {
        results.push({
          task_id: task.task_id,
          success: false,
          error: error instanceof Error ? error.message : "Processing failed",
        });
      }
    }

    return NextResponse.json({
      success: true,
      agent_id,
      tasks_processed: results.length,
      results,
    });
  } catch (error) {
    console.error("[AIP Poll] Error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Polling failed",
      },
      { status: 500 }
    );
  }
}
