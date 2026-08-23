import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "Please sign in to vote." }, { status: 401 });
  }

  if (!process.env.DATABASE_URL) {
    return Response.json({ error: "Database storage is not configured yet." }, { status: 503 });
  }

  let body: { roundId?: unknown; modelId?: unknown };
  try {
    body = (await request.json()) as { roundId?: unknown; modelId?: unknown };
  } catch {
    return Response.json({ error: "Please send a valid vote." }, { status: 400 });
  }

  if (typeof body.roundId !== "string" || typeof body.modelId !== "string") {
    return Response.json({ error: "A round and model are required." }, { status: 400 });
  }

  const round = await prisma.round.findUnique({
    where: { id: body.roundId },
    include: { user: true, responses: true },
  });

  if (!round || round.user.clerkId !== userId) {
    return Response.json({ error: "This round is not available." }, { status: 404 });
  }

  if (round.responses.filter((response) => response.status === "complete").length < 2) {
    return Response.json({ error: "At least two models must answer before voting." }, { status: 409 });
  }

  if (!round.responses.some((response) => response.modelId === body.modelId && response.status === "complete")) {
    return Response.json({ error: "That model did not complete this round." }, { status: 400 });
  }

  try {
    const vote = await prisma.vote.create({
      data: { roundId: round.id, userId: round.userId, modelId: body.modelId },
    });
    return Response.json({ voteId: vote.id });
  } catch {
    return Response.json({ error: "This round already has a vote." }, { status: 409 });
  }
}
