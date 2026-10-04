// Two users at once: the session the code runs on, and a second with a browser of its own.
export default async ({ page, step, newSession }: any) => {
  await step({ goto: "/" });
  await step({ js: "document.cookie = 'who=first'" });
  const second = await newSession({ name: "second", viewport: "500x400@1", path: "/other" });
  await second.step({ expect: "Other page" });
  await second.step({ shot: "other" });
  const cookie = await second.step({ js: "document.cookie" });
  await step({ expect: "Fixture app" });
  const answer = { first: await page.title(), second: await second.page.title(), cookie, width: await second.page.evaluate(() => innerWidth) };
  await second.end();
  return answer;
};
