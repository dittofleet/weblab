// The code itself throws, and the failure says where.
export default async ({ step }: { step: (step: object) => Promise<unknown> }) => {
  await step({ goto: "/" });
  throw new Error("thrown by the code");
};
