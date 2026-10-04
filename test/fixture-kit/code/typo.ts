// A step inside the code is misspelt.
export default async ({ step }: { step: (step: object) => Promise<unknown> }) => {
  await step({ goto: "/" });
  await step({ clik: "#inc" });
};
