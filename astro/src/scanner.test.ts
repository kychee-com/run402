import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanForImageRefs } from "./scanner.js";

const FILE = "/test/index.astro";

describe("scanner", () => {
  it("extracts a single literal src", () => {
    const src = `<Image src="./hero.jpg" alt="hero" />`;
    const { references, warnings } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 1);
    assert.equal(references[0]?.src, "./hero.jpg");
    assert.equal(warnings.length, 0);
  });

  it("extracts multiple refs across the file", () => {
    const src = `
      <Image src="./a.jpg" alt="a" />
      <p>some stuff</p>
      <Image src="./b.png" alt="b" sizes="50vw" />
      <Image src='./c.webp' alt='c' />
    `;
    const { references } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 3);
    assert.deepEqual(
      references.map((r) => r.src).sort(),
      ["./a.jpg", "./b.png", "./c.webp"],
    );
  });

  it("does NOT match <ImageGallery> (only <Image followed by separator)", () => {
    const src = `<ImageGallery src="./hero.jpg" />`;
    const { references } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 0);
  });

  it("handles src={'literal'} JSX expression form", () => {
    const src = `<Image src={"./hero.jpg"} alt="x" />`;
    const { references } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 1);
    assert.equal(references[0]?.src, "./hero.jpg");
  });

  it("warns on dynamic src={expr}", () => {
    const src = `<Image src={myImage} alt="dynamic" />`;
    const { references, warnings } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "dynamic-src");
  });

  it("warns on spread props", () => {
    const src = `<Image {...imgProps} alt="x" />`;
    const { references, warnings } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "spread-props");
  });

  it("warns when no src prop is present", () => {
    const src = `<Image alt="oops" />`;
    const { warnings } = scanForImageRefs(src, FILE);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "no-src");
  });

  it("reports approximate line numbers", () => {
    const src = `\n\n\n<Image src="./hero.jpg" alt="x" />\n`;
    const { references } = scanForImageRefs(src, FILE);
    assert.equal(references[0]?.line, 4);
  });

  it("ignores quotes inside JSX expression interpolations", () => {
    // The expression contains a `>` inside a string, which must NOT
    // terminate the tag body early.
    const src = `<Image src="./a.jpg" alt={\`hello > world\`} />`;
    const { references } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 1);
    assert.equal(references[0]?.src, "./a.jpg");
  });

  it("handles deeply nested .astro syntax", () => {
    const src = `
      ---
      const x = 1;
      ---
      <div>
        <section>
          <article>
            <Image src="./deep.jpg" alt="deep" sizes="100vw" />
          </article>
        </section>
      </div>
    `;
    const { references } = scanForImageRefs(src, FILE);
    assert.equal(references.length, 1);
    assert.equal(references[0]?.src, "./deep.jpg");
  });
});
