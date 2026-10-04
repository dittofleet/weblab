// Code that catches one failed step and goes on, runs two at once, then lets a later failure through.
export default async ({ step }: { step: (step: object) => Promise<unknown> }) => {
  await step({ goto: "/" });
  try {
    await step({ expect: "not there", timeout: 200 });
  } catch {
    // Expected; the code carries on.
  }
  await Promise.all([step({ js: "1" }), step({ js: "2" })]);
  await step({ expect: "nor this", timeout: 200, message: "the one that counts" });
};
