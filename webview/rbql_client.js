var rbql_running = false;

var handshake_completed = false;

var query_history = [];

const vscode = acquireVsCodeApi();

var global_css_style = null;

var last_preview_message = null;

var adjust_join_table_header_callback = null;

var global_header = null;

// Every entry is static markup in rbql_client.html, so the lookups are done once in main() instead of on each
// keystroke and each preview redraw. Element ids passed to rbql_suggest stay strings: it resolves them itself.
const el = {};
const CACHED_ELEMENT_IDS = [
    'ack_error',
    'clear_history_btn',
    'close_help',
    'error_message_details',
    'error_message_header',
    'go_backward',
    'go_begin',
    'go_end',
    'go_forward',
    'help_btn',
    'history_entries',
    'preview_table',
    'query_history',
    'rbql_error_message',
    'rbql_help',
    'rbql_input',
    'rbql_run_btn',
    'select_backend_language',
    'select_encoding',
    'select_output_format',
    'toggle_history_btn',
    'udf_button',
    'with_headers',
];


function cache_elements() {
    for (const element_id of CACHED_ELEMENT_IDS) {
        el[element_id] = document.getElementById(element_id);
    }
}


function report_backend_language_change() {
    let backend_language = el.select_backend_language.value;
    vscode.postMessage({'msg_type': 'global_param_change', 'key': 'rbql_backend_language', 'value': backend_language});
    assign_backend_lang_selection_title();
}


function report_encoding_change() {
    let encoding = el.select_encoding.value;
    vscode.postMessage({'msg_type': 'global_param_change', 'key': 'rbql_encoding', 'value': encoding});
}


function remove_children(root_node) {
    while (root_node.firstChild) {
        root_node.removeChild(root_node.firstChild);
    }
}


function get_max_num_columns(records, with_headers) {
    let max_num_columns = 0;
    for (let r = 0; r < records.length; r++) {
        max_num_columns = Math.max(max_num_columns, records[r].length);
    }
    if (with_headers && global_header && global_header.length)
        max_num_columns = Math.max(max_num_columns, global_header.length);
    return max_num_columns;
}


function add_header_cell_with_text(cell_text, dst_row_elem) {
    let cell = document.createElement('th');
    cell.textContent = cell_text;
    dst_row_elem.appendChild(cell);
}


function add_header_row(max_num_columns, with_headers, table) {
    let row_elem = document.createElement('tr');
    add_header_cell_with_text('NR', row_elem);
    let named_header_vars = [];
    if (with_headers && global_header && global_header.length) {
        named_header_vars = rbql_suggest.convert_header_to_rbql_variables(global_header, 'a');
    }
    for (let i = 0; i < max_num_columns; i++) {
        let cell_text = `a${i + 1}`;
        if (i < named_header_vars.length) {
            let var_column = named_header_vars[i].dot_var ? named_header_vars[i].dot_var : named_header_vars[i].single_q_var;
            cell_text += '\r\n' + var_column;
        }
        add_header_cell_with_text(cell_text, row_elem);
    }
    table.appendChild(row_elem);
}


function make_data_cell(cell_text) {
    let cell = document.createElement('td');
    const trim_marker = '###UI_STRING_TRIM_MARKER###';
    let add_ellipsis = false;
    if (cell_text.endsWith(trim_marker)) {
        cell_text = cell_text.substr(0, cell_text.length - trim_marker.length);
        add_ellipsis = true;
    }
    let field_rfc_lines = cell_text.split('\n');
    for (let i = 0; i < field_rfc_lines.length; i++) {
        let span = document.createElement('span');
        span.textContent = field_rfc_lines[i];
        cell.appendChild(span);
        if (i + 1 < field_rfc_lines.length) {
            let newline_span = document.createElement('span');
            newline_span.textContent = '\\n';
            newline_span.style.color = global_css_style.getPropertyValue('--vscode-editorWarning-foreground');
            newline_span.title = 'new line';
            cell.appendChild(newline_span);
        }
    }
    if (add_ellipsis) {
        let ellipsis_span = document.createElement('span');
        ellipsis_span.style.color = global_css_style.getPropertyValue('--vscode-editorWarning-foreground');
        ellipsis_span.textContent = ' ...';
        ellipsis_span.title = 'value too long to display';
        cell.appendChild(ellipsis_span);
    }
    return cell;
}


function make_nr_cell(cell_text) {
    let nr_cell = document.createElement('td');
    nr_cell.textContent = cell_text;
    return nr_cell;
}


function make_preview_table() {
    if (!last_preview_message)
        return;
    let records = last_preview_message.preview_records;
    let actual_start_record = last_preview_message.actual_start_record;
    let preview_error = last_preview_message.preview_sampling_error;

    var table = el.preview_table;
    remove_children(table);
    if (preview_error) {
        let row = document.createElement('tr');
        table.appendChild(row);
        let span = document.createElement('span');
        span.style.color = global_css_style.getPropertyValue('--vscode-inputValidation-errorForeground');
        span.textContent = 'Unable to display preview table and run RBQL query:';
        row.appendChild(span);
        row.appendChild(document.createElement('br'));
        span = document.createElement('span');
        span.style.color = global_css_style.getPropertyValue('--vscode-inputValidation-errorForeground');
        span.textContent = preview_error;
        row.appendChild(span);
        return;
    }

    let with_headers = el.with_headers.checked;
    let max_num_columns = get_max_num_columns(records, with_headers);
    add_header_row(max_num_columns, with_headers, table);
    for (var r = 0; r < records.length; r++) {
        let row = document.createElement('tr');
        let NR = r + actual_start_record + 1;
        if (with_headers) {
            NR -= 1;
            if (NR == 0)
                continue;
        }
        row.appendChild(make_nr_cell(String(NR)));
        for (var nf = 0; nf < records[r].length; nf++) {
            row.appendChild(make_data_cell(records[r][nf]));
        }
        table.appendChild(row);
    }
}


function navigate_preview(direction) {
    vscode.postMessage({'msg_type': 'navigate', 'direction': direction});
}


function preview_backward() {
    navigate_preview('backward');
}


function preview_forward() {
    navigate_preview('forward');
}


function preview_begin() {
    navigate_preview('begin');
}


function preview_end() {
    navigate_preview('end');
}


function apply_suggest_callback(query) {
    vscode.postMessage({'msg_type': 'update_query', 'query': query});
}


function fetch_join_header_callback(join_table_id, adjust_join_table_headers) {
    adjust_join_table_header_callback = adjust_join_table_headers;
    let encoding = el.select_encoding.value;
    vscode.postMessage({'msg_type': 'fetch_table_header', 'table_id': join_table_id, 'encoding': encoding});
}


function process_with_headers_change() {
    let with_headers = el.with_headers.checked;
    vscode.postMessage({'msg_type': 'with_headers_change', 'with_headers': with_headers}); // We need to send it to remember preview state
    let header = with_headers ? global_header : null;
    rbql_suggest.initialize_suggest('rbql_input', 'query_suggest', 'history_button', apply_suggest_callback, header, fetch_join_header_callback);
    make_preview_table();
}


function show_error(error_type, error_msg) {
    el.error_message_header.textContent = 'Error type: "' + error_type + '"';
    el.error_message_details.textContent = error_msg;
    el.rbql_error_message.style.display = 'block';
    el.ack_error.focus();
}


function hide_error_msg() {
    el.rbql_error_message.style.display = 'none';
    el.rbql_input.focus();
}


function toggle_help_msg() {
    let document_bg_color = global_css_style.getPropertyValue('--vscode-notifications-background');
    let rbql_help_element = el.rbql_help;
    var style_before = rbql_help_element.style.display;
    var new_style = style_before == 'block' ? 'none' : 'block';
    if (new_style == 'block')
        rbql_help_element.style.backgroundColor = document_bg_color;
    rbql_help_element.style.display = new_style;
    el.close_help.style.display = new_style;
}


function register_history_callback(button_element, query) {
    button_element.addEventListener("click", () => { el.rbql_input.value = query; });
}


function toggle_history() {
    let query_history_block = el.query_history;
    var style_before = query_history_block.style.display;
    var new_style = style_before == 'block' ? 'none' : 'block';
    if (new_style == 'block') {
        el.toggle_history_btn.textContent = '\u25BC';
    } else {
        el.toggle_history_btn.textContent = '\u25B2';
    }
    let history_entries_block = el.history_entries;
    remove_children(history_entries_block);
    for (let nr = 0; nr < query_history.length; nr++) {
        let entry_button = document.createElement('button');
        entry_button.className = 'history_button';
        entry_button.textContent = query_history[nr];
        register_history_callback(entry_button, query_history[nr]);
        history_entries_block.appendChild(entry_button);
    }
    query_history_block.style.display = new_style;
    let calculated_height = query_history_block.offsetHeight;
    let text_input_coordinates = el.rbql_input.getBoundingClientRect();
    query_history_block.style.left = text_input_coordinates.left + 'px';
    query_history_block.style.top = (text_input_coordinates.top - calculated_height) + 'px';
}


function clear_history() {
    query_history = [];
    toggle_history();
    vscode.postMessage({'msg_type': 'global_param_change', 'key': 'rbql_query_history', 'value': []});
}


function start_rbql() {
    var rbql_text = el.rbql_input.value;
    if (!rbql_text || rbql_running)
        return;
    rbql_running = true;
    el.rbql_run_btn.textContent = "\u231B";
    let backend_language = el.select_backend_language.value;
    let output_format = el.select_output_format.value;
    let encoding = el.select_encoding.value;
    let with_headers = el.with_headers.checked;
    vscode.postMessage({'msg_type': 'run', 'query': rbql_text, 'backend_language': backend_language, 'output_dialect': output_format, 'encoding': encoding, 'with_headers': with_headers});
}


function maybe_run_integration_test(message) {
    // Both integration suites drive this panel through the `rainbow-csv.RBQL` command rather than through the UI:
    // extension.js forwards the query in the handshake and the run has to be started from here. Kept in one function
    // so the handshake above reads as the production path only.
    let integration_test_query = message['integration_test_query'];
    let integration_test_language = message['integration_test_language'];
    if (!integration_test_query || !integration_test_language) {
        return;
    }
    let integration_test_delay = message.hasOwnProperty('integration_test_delay') ? message.integration_test_delay : 2000;
    el.with_headers.checked = Boolean(message['integration_test_with_headers']);
    process_with_headers_change();
    el.select_backend_language.value = integration_test_language;
    assign_backend_lang_selection_title();
    el.rbql_input.value = integration_test_query;
    setTimeout(start_rbql, integration_test_delay);
}


function handle_message(msg_event) {
    var message = msg_event.data;
    console.log('message received at client: ' + JSON.stringify(msg_event));
    let message_type = message['msg_type'];

    if (message_type == 'handshake') {
        if (handshake_completed)
            return;
        handshake_completed = true;
        if (message.hasOwnProperty('last_query')) {
            el.rbql_input.value = message['last_query'];
        }
        if (message.hasOwnProperty('query_history')) {
            query_history = message['query_history'];
        }
        global_header = message['header_for_ui'];
        let with_headers = message['with_headers'];
        let header = with_headers ? global_header : null;
        rbql_suggest.initialize_suggest('rbql_input', 'query_suggest', 'history_button', apply_suggest_callback, header, fetch_join_header_callback);
        last_preview_message = message;
        el.select_backend_language.value = message['backend_language'];
        assign_backend_lang_selection_title();
        el.select_encoding.value = message['encoding'];
        el.with_headers.checked = with_headers;
        make_preview_table();

        maybe_run_integration_test(message);
    }

    if (message_type == 'fetch_table_header_response') {
        if (adjust_join_table_header_callback && message['header_for_ui']) {
            adjust_join_table_header_callback(message['header_for_ui']);
        }
    }

    if (message_type == 'navigate' || message_type == 'resample') {
        last_preview_message = message;
        make_preview_table();
    }

    if (message_type == 'rbql_report') {
        rbql_running = false;
        if (message.hasOwnProperty('error_type') || message.hasOwnProperty('error_msg')) {
            let error_type = message.hasOwnProperty('error_type') ? message['error_type'] : 'Unexpected';
            let error_msg = message.hasOwnProperty('error_msg') ? message['error_msg'] : 'Unknown Error';
            show_error(error_type, error_msg);
        }
        el.rbql_run_btn.textContent = "Run";
    }
}


function is_printable_key_code(keycode) {
    // Taken from here: https://stackoverflow.com/a/12467610/2898283
    return (keycode > 47 && keycode < 58) || keycode == 32 || (keycode > 64 && keycode < 91) || (keycode > 185 && keycode < 193) || (keycode > 218 && keycode < 223);
}


function handle_input_keyup(event) {
    rbql_suggest.handle_input_keyup(event);
    if (is_printable_key_code(event.keyCode) || event.keyCode == 8 /* Bakspace */) {
        let current_query = el.rbql_input.value;
        vscode.postMessage({'msg_type': 'update_query', 'query': current_query});
    }
}


function handle_input_keydown(event) {
    if (event.keyCode == 13 && rbql_suggest.active_suggest_idx === null) {
        start_rbql();
    } else {
        rbql_suggest.handle_input_keydown(event);
    }
}


function assign_backend_lang_selection_title() {
    let select_backend_element = el.select_backend_language;
    let backend_language = select_backend_element.value;
    if (backend_language == 'js') {
        select_backend_element.title = 'Allows to use JS expressions such as: `Math.sqrt(a1)`, `a2.substring(1, 5)`, `a3.toUpperCase()`, etc';
    } else {
        select_backend_element.title = 'Allows to use Python expressions such as: `math.sqrt(float(a1))`, `a2[1:5]`, `a3.upper()`, etc';
    }
}


function handle_udf_edit() {
    let backend_language = el.select_backend_language.value;
    vscode.postMessage({'msg_type': 'edit_udf', 'backend_language': backend_language});
}


function main() {
    cache_elements();
    global_css_style = getComputedStyle(document.body);
    assign_backend_lang_selection_title();

    window.addEventListener('message', handle_message);
    vscode.postMessage({'msg_type': 'handshake'});

    el.rbql_run_btn.addEventListener("click", start_rbql);
    el.select_backend_language.addEventListener("change", report_backend_language_change);
    el.select_encoding.addEventListener("change", report_encoding_change);
    el.with_headers.addEventListener("click", process_with_headers_change);
    el.ack_error.addEventListener("click", hide_error_msg);
    el.help_btn.addEventListener("click", toggle_help_msg);
    el.close_help.addEventListener("click", toggle_help_msg);
    el.toggle_history_btn.addEventListener("click", toggle_history);
    el.clear_history_btn.addEventListener("click", clear_history);
    el.go_begin.addEventListener("click", preview_begin);
    el.go_backward.addEventListener("click", preview_backward);
    el.go_forward.addEventListener("click", preview_forward);
    el.go_end.addEventListener("click", preview_end);
    el.rbql_input.addEventListener("keyup", handle_input_keyup);
    el.rbql_input.addEventListener("keydown", handle_input_keydown);
    el.udf_button.addEventListener("click", handle_udf_edit);
    el.rbql_input.focus();
}


document.addEventListener("DOMContentLoaded", function(_event) {
    main();
});
