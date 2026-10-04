// Code that runs steps, reads what they hand back, and returns its own value.
export default async ({ step, logs }: { step: (step: object) => Promise<unknown>; logs: { text: string }[] }) => {
  await step({ goto: "/" });
  const title = await step({ js: "document.title" });
  if (title !== "fixture") throw new Error(`the title was ${title}`);
  console.log("printed by the code file");
  if (!logs.some((entry) => entry.text === "fixture mounted")) throw new Error("the page's logs are missing");
  return { title };
};
