import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

type LeaderboardAccumulator = { modelId: string; answers: number; wins: number; ttft: number[]; speed: number[] };

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export default async function LeaderboardPage() {
  const { userId } = await auth();
  const responses = process.env.DATABASE_URL ? await prisma.modelResponse.findMany({ where: { status: "complete" }, include: { round: { include: { vote: true, user: true } } } }) : [];
  const rows = new Map<string, LeaderboardAccumulator>();

  responses.filter((response) => !userId || response.round.user.clerkId === userId).forEach((response) => {
    const row = rows.get(response.modelId) ?? { modelId: response.modelId, answers: 0, wins: 0, ttft: [], speed: [] };
    row.answers += 1;
    if (response.round.vote?.modelId === response.modelId) row.wins += 1;
    if (response.timeToFirstTokenMs !== null) row.ttft.push(response.timeToFirstTokenMs);
    if (response.tokensPerSecond !== null) row.speed.push(response.tokensPerSecond);
    rows.set(response.modelId, row);
  });

  const leaderboard = [...rows.values()].sort((first, second) => second.wins / second.answers - first.wins / first.answers);

  return <main className="leaderboard-page"><header className="leaderboard-header"><Link href="/">← Arena</Link><span>LLM Arena</span><span>{userId ? "Personal results" : "Global results"}</span></header><section className="leaderboard-content"><p className="eyebrow">Measured from real comparisons</p><h1>Leaderboard</h1><p className="leaderboard-copy">Every result comes from an answered round and a recorded vote.</p><div className="leaderboard-table"><div className="table-head"><span>#</span><span>Model</span><span>Win rate</span><span>Avg. TTFT</span><span>Avg. speed</span></div>{leaderboard.length ? leaderboard.map((row, index) => <div className={`table-row ${index === 0 ? "first-place" : ""}`} key={row.modelId}><span>{index + 1}</span><strong>{row.modelId}</strong><span className="win-rate">{Math.round((row.wins / row.answers) * 100)}% <small>won {row.wins} of {row.answers}</small></span><span>{average(row.ttft) === null ? "--" : `${Math.round(average(row.ttft) ?? 0)} ms`}</span><span>{average(row.speed) === null ? "--" : `${Math.round(average(row.speed) ?? 0)} tok/s`}</span></div>) : <div className="empty-leaderboard">No completed comparisons yet.</div>}</div></section></main>;
}
