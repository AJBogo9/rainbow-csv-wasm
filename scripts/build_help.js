// Renders the RBQL help panel inside webview/rbql_client.html from rbql_core/README.md.
//
// The panel used to be a hand-maintained copy of the README and had already drifted from it (the "Pipe syntax for
// query chaining" and "Supported formats" sections were never carried over). Regenerate with `npm run build-help`
// after editing the README; `npm run build-help -- --check` verifies the checked-in file is current without writing.

const fs = require('fs');
const path = require('path');
const {marked} = require('marked');

const REPO_ROOT = path.join(__dirname, '..');
const README_PATH = path.join(REPO_ROOT, 'rbql_core', 'README.md');
const CLIENT_HTML_PATH = path.join(REPO_ROOT, 'webview', 'rbql_client.html');

// The panel documents the query language itself. Everything from the first heading up to the design discussion is
// relevant to someone writing a query; what follows it (architecture, comparisons with other engines, references) is
// not, so it is the natural cut point.
const HELP_START_HEADING = '# RBQL: Rainbow Query Language';
const HELP_END_HEADING = '## RBQL design principles and architecture';

const BEGIN_MARKER = '        <!-- BEGIN GENERATED HELP: npm run build-help (source: rbql_core/README.md) -->';
const END_MARKER = '        <!-- END GENERATED HELP -->';


function render_help_html() {
    let readme = fs.readFileSync(README_PATH, 'utf8');
    // Skip the README's own banner image and site link: the image is not packaged into the extension and the panel
    // already links to rbql.org above the generated block.
    let start_pos = readme.indexOf(HELP_START_HEADING);
    let end_pos = readme.indexOf(HELP_END_HEADING);
    if (start_pos === -1 || end_pos === -1 || end_pos < start_pos) {
        throw new Error(`Unable to slice the help section out of ${README_PATH}. Adjust the heading constants in this script.`);
    }
    let help_markdown = readme.substring(start_pos, end_pos).trim();
    let rendered = marked.parse(help_markdown, {mangle: false, headerIds: false});
    // Indent to match the surrounding markup so the generated block does not stand out in a diff.
    return rendered.trimEnd().split('\n').map(line => line ? '        ' + line : line).join('\n');
}


function splice_into_client_html(client_html, help_html) {
    let begin_pos = client_html.indexOf(BEGIN_MARKER);
    let end_pos = client_html.indexOf(END_MARKER);
    if (begin_pos === -1 || end_pos === -1 || end_pos < begin_pos) {
        throw new Error(`Unable to find the generated-help markers in ${CLIENT_HTML_PATH}.`);
    }
    let prefix = client_html.substring(0, begin_pos + BEGIN_MARKER.length);
    let suffix = client_html.substring(end_pos);
    return `${prefix}\n${help_html}\n${suffix}`;
}


function main() {
    let check_only = process.argv.includes('--check');
    let client_html = fs.readFileSync(CLIENT_HTML_PATH, 'utf8');
    let updated_html = splice_into_client_html(client_html, render_help_html());
    if (updated_html === client_html) {
        console.log('RBQL help panel is up to date.');
        return;
    }
    if (check_only) {
        console.error('RBQL help panel is out of date with rbql_core/README.md. Run `npm run build-help`.');
        process.exit(1);
    }
    fs.writeFileSync(CLIENT_HTML_PATH, updated_html);
    console.log(`Regenerated the RBQL help panel in ${path.relative(REPO_ROOT, CLIENT_HTML_PATH)}.`);
}


main();
