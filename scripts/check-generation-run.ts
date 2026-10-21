import { prisma } from "../src/lib/db";

async function main() {
  const runId = process.argv[2];

  if (!runId) {
    throw new Error("Generation run ID is required");
  }

  const run = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });

  console.log(JSON.stringify(run, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
