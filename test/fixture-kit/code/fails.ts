// A step inside the code fails, and the code lets it through.
export default async ({ step }: { step: (step: object) => Promise<unknown> }) => {
  await step({ goto: "/" });
  await step({ expect: "never there", timeout: 300, message: "deliberately missing" });
};
