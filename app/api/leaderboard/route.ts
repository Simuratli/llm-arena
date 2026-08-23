import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

type LeaderboardAccumulator = { modelId: string; answers: number; wins: number; ttft: number[]; elapsed: number[]; speed: number[]; tokens: number };

export async function GET(request: Request) {
  if (!process.env.DATABASE_URL) {
    return Response.json({ error: "Database storage is not configured yet." }, { status: 503 });
  }

  const { userId } = await auth();
  const scope = new URL(request.url).searchParams.get("scope") === "personal" ? "personal" : "global";

  if (scope === "personal" && !userId) {
    return Response.json({ error: "Please sign in to view your leaderboard." }, { status: 401 });
  }

  const responses = await prisma.modelResponse.findMany({
    where: {
      status: "complete",
      ...(scope === "personal" ? { round: { user: { clerkId: userId ?? "" } } } : {}),
    },
    include: { round: { include: { vote: true } } },
  });

  const rows = new Map<string, LeaderboardAccumulator>();
  responses.forEach((response) => {
    const row = rows.get(response.modelId) ?? { modelId: response.modelId, answers: 0, wins: 0, ttft: [], elapsed: [], speed: [], tokens: 0 };
    row.answers += 1;
    if (response.round.vote?.modelId === response.modelId) row.wins += 1;
    if (response.timeToFirstTokenMs !== null) row.ttft.push(response.timeToFirstTokenMs);
    if (response.elapsedMs !== null) row.elapsed.push(response.elapsedMs);
    if (response.tokensPerSecond !== null) row.speed.push(response.tokensPerSecond);
    row.tokens += response.totalTokens ?? 0;
    rows.set(response.modelId, row);
  });

  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const leaderboard = [...rows.values()]
    .map((row) => ({ modelId: row.modelId, answers: row.answers, wins: row.wins, winRate: row.answers ? row.wins / row.answers : 0, averageTimeToFirstTokenMs: average(row.ttft), averageElapsedMs: average(row.elapsed), averageTokensPerSecond: average(row.speed), totalTokens: row.tokens }))
    .sort((first, second) => second.winRate - first.winRate || second.wins - first.wins);

  return Response.json({ scope, leaderboard });
}
