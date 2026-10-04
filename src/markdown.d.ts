// The docs pages, brought into the binary as text.
declare module "*.md" {
  const text: string;
  export default text;
}
