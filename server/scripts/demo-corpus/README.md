# The demo corpus's migration material

Two exports, read by `seed-demo.ts` so that the demo record contains pages that
came from somewhere else — which is what makes `provenance: imported` a real
thing on the knowledge map rather than a legend entry with nothing under it.

They live here, and not in `server/test/fixtures/`, on purpose. The test
fixtures exist to exercise the importer against material that is *broken*:
their pages are called "Messy Legacy Page" and "Orphan Note" because those
names describe the defect each file carries. Reusing them for the demo put two
pages called "Orphan Note" and "Messy Legacy Page" into a company's record, and
three page titles that collided with seeded ones — a reviewer read all of that
as the product's own sloppiness (USER-TESTING.md T4.8).

So these are what a real migration looks like: the benefits team's old
Confluence wiki, and three Google Docs the clinical team kept outside it. The
awkward shapes are still here, because the importer earns its keep on them and
the demo should show it — a page the space index never listed, whose place in
the tree comes from its breadcrumbs; a page pasted out of a 2019 intranet with
unclosed tags, inline styles and a script block; and an export the tool died
halfway through, which fails and is reported as failed. What is different is
that every one of them is now a document a benefits team would recognise.

Nothing here is real. Every name is invented and every address is on
`example.com`, which RFC 2606 reserves so that nothing in this directory can
ever be delivered anywhere.
