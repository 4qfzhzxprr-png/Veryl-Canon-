A real Confluence HTML space export puts page attachments here, one directory
per page id. The importer ignores this directory: attachment files are not
carried into the record in Core, and an <img> in a page body becomes a link to
where the file sat in the export.

This placeholder exists so the fixture has the directory an operator will
actually have on disk, and so the test can prove the importer walks past it.
