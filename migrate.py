import sys
import re

def main():
    src = r'docs/rebuild/new build/code.html'
    dest = 'index.html'

    with open(src, 'r', encoding='utf-8') as f:
        html = f.read()

    # 1. Remove the `<script>` block at the end (the simulation one)
    html = re.sub(r'<script>\s*document\.addEventListener\(\'DOMContentLoaded\'.*?</script>', '', html, flags=re.DOTALL)
    
    # 2. Inject Vite main.ts script right before </body>
    html = html.replace('</body>', '  <script type="module" src="/src/main.ts"></script>\n</body>')
    
    # 3. Inject missing IDs for main.ts compatibility
    # Lang toggle: wrap EN / AR buttons
    html = html.replace(
        '<button class="text-on-surface-variant',
        '<div id="lang-toggle" class="flex items-center gap-stack-md cursor-pointer group">\n<button class="text-on-surface-variant'
    )
    # the end of that block is `</button>` for AR
    html = html.replace(
        '>AR</button>',
        '>AR</button>\n</div>'
    )

    # mode-song
    html = html.replace(
        '<button class="glass-effect border-[1.5px] border-clay-accent/50',
        '<button id="mode-song" data-mode="song" class="mode-card selected glass-effect border-[1.5px] border-clay-accent/50'
    )
    
    # mode-clip
    html = html.replace(
        '<button class="glass-effect border border-border-muted rounded-lg p-stack-lg flex flex-col items-center justify-center gap-stack-sm opacity-70 transition-all duration-300 apple-ease hover:opacity-100',
        '<button id="mode-clip" data-mode="clip" class="mode-card glass-effect border border-border-muted rounded-lg p-stack-lg flex flex-col items-center justify-center gap-stack-sm opacity-70 transition-all duration-300 apple-ease hover:opacity-100'
    )
    
    # keep-inst-checkbox -> keep-inst
    html = html.replace('id="keep-inst-checkbox"', 'id="keep-inst"')

    # fmt-select
    html = html.replace(
        '<select class="form-select',
        '<select id="fmt-select" class="form-select'
    )
    
    # media-verdict
    html = html.replace(
        '<div class="flex justify-between items-center bg-coal-surface/40',
        '<div id="media-verdict" class="flex justify-between items-center bg-coal-surface/40'
    )
    
    # kind-audio
    html = html.replace(
        '<button class="bg-clay-accent/10 text-clay-accent border border-clay-accent/30',
        '<button id="kind-audio" data-kind="audio" class="kind-card selected bg-clay-accent/10 text-clay-accent border border-clay-accent/30'
    )

    # kind-video
    html = html.replace(
        '<button class="text-on-surface-variant opacity-50 px-stack-sm py-unit rounded',
        '<button id="kind-video" data-kind="video" class="kind-card text-on-surface-variant opacity-50 px-stack-sm py-unit rounded'
    )
    
    # process-btn -> btn-separate
    html = html.replace(
        'id="process-btn"',
        'id="btn-separate"'
    )
    
    # sep-label
    html = html.replace(
        'فصل الصوت',
        '<span id="sep-label" data-i18n="btn_sep_song">فصل الصوت</span>'
    )

    # URL input
    html = html.replace(
        '<input class="flex-1 bg-coal-surface/50 border border-border-muted rounded',
        '<input id="url-input" class="flex-1 bg-coal-surface/50 border border-border-muted rounded'
    )
    
    # btn-download
    html = html.replace(
        '<button class="bg-surface-container text-cream-text border border-border-muted px-stack-md py-stack-sm rounded hover:bg-surface-container-high hover:border-on-surface-variant transition-all duration-300 apple-ease font-label-md text-label-md flex items-center gap-unit active:scale-95 shadow-sm group">',
        '<button id="btn-download" class="bg-surface-container text-cream-text border border-border-muted px-stack-md py-stack-sm rounded hover:bg-surface-container-high hover:border-on-surface-variant transition-all duration-300 apple-ease font-label-md text-label-md flex items-center gap-unit active:scale-95 shadow-sm group">'
    )
    
    # btn-upd-ytdlp
    html = html.replace(
        '<span class="font-label-sm text-label-sm">yt-dlp محدث لآخر إصدار</span>',
        '<button id="btn-upd-ytdlp" class="font-label-sm text-label-sm hover:text-clay-accent cursor-pointer transition-colors duration-200">yt-dlp محدث لآخر إصدار</button>'
    )
    
    # batch-list (we will replace the inside of the aside div)
    # Actually, we can just find `<div class="flex-1 overflow-y-auto p-stack-md flex flex-col gap-stack-sm">` and add id
    html = html.replace(
        '<div class="flex-1 overflow-y-auto p-stack-md flex flex-col gap-stack-sm">',
        '<div id="batch-list" class="flex-1 overflow-y-auto p-stack-md flex flex-col gap-stack-sm hidden">'
    )
    
    # batch-counter
    html = html.replace(
        'طابور المعالجة',
        'طابور المعالجة <span id="batch-counter" class="hidden text-sm ml-auto mr-4"></span>'
    )

    # sep-progress-wrap and sep-progress (add after btn-separate)
    progress_html = """
    <div id="sep-progress-wrap" class="hidden h-1.5 bg-border-muted rounded-full overflow-hidden mt-2">
      <div id="sep-progress" class="h-full bg-clay-accent w-0 rounded-full transition-all duration-300"></div>
    </div>
    <p id="sep-result" class="hidden text-clay-accent text-sm mt-2 whitespace-pre-wrap text-center"></p>
    """
    html = html.replace(
        '<span class="material-symbols-outlined transition-transform duration-300 apple-ease group-hover:rotate-12 group-hover:scale-110" data-icon="content_cut">content_cut</span>\n</button>',
        '<span class="material-symbols-outlined transition-transform duration-300 apple-ease group-hover:rotate-12 group-hover:scale-110" data-icon="content_cut">content_cut</span>\n</button>\n' + progress_html
    )

    # dl-progress-wrap (add after btn-download)
    dl_progress_html = """
    <div id="dl-progress-wrap" class="hidden w-full h-1.5 bg-border-muted rounded-full overflow-hidden mt-2">
      <div id="dl-progress" class="h-full bg-clay-accent w-0 rounded-full transition-all duration-300"></div>
    </div>
    <p id="dl-result" class="hidden text-clay-accent text-sm mt-2"></p>
    """
    html = html.replace(
        '<!-- URL Card -->',
        '<!-- URL Card -->\n<div id="dl-container" class="w-full">'
    )
    html = html.replace(
        'yt-dlp محدث لآخر إصدار</button>\n</div>\n</div>',
        'yt-dlp محدث لآخر إصدار</button>\n</div>\n' + dl_progress_html + '\n</div>\n</div>'
    )
    
    # hidden input for media-path
    html = html.replace('</body>', '<input type="hidden" id="media-path" />\n</body>')
    
    # log-toggle and logcard
    html = html.replace(
        '<div class="glass-effect border-t border-border-muted flex flex-col z-50 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.5)]">',
        '<div id="logcard" class="glass-effect border-t border-border-muted flex flex-col z-50 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.5)] collapsed">'
    )
    
    html = html.replace(
        '<button class="w-full flex justify-between items-center px-gutter',
        '<button id="log-toggle" class="w-full flex justify-between items-center px-gutter'
    )
    
    html = html.replace(
        'id="log-container"',
        'id="log-view"'
    )
    
    # autoscroll checkbox in log toggle
    html = html.replace(
        'سجل الأحداث / Activity Log\n            </span>',
        'سجل الأحداث / Activity Log\n            </span>\n<label class="autoscroll ml-4 text-xs" onclick="event.stopPropagation()"><input type="checkbox" id="autoscroll" checked /> تلقائي التمرير</label>'
    )
    
    # Add CSS for 'selected' modes to the style block
    style_add = """
        .mode-card.selected {
            border-color: rgba(218, 119, 86, 0.5) !important;
            background-color: rgba(218, 119, 86, 0.1) !important;
            opacity: 1 !important;
        }
        .mode-card:not(.selected) {
            border-color: #2E2C29 !important;
            background-color: transparent !important;
            opacity: 0.7 !important;
        }
        .kind-card.selected {
            background-color: rgba(218, 119, 86, 0.1) !important;
            border-color: rgba(218, 119, 86, 0.3) !important;
            opacity: 1 !important;
        }
        .kind-card:not(.selected) {
            background-color: transparent !important;
            border-color: transparent !important;
            opacity: 0.5 !important;
        }
        #logcard.collapsed #log-view {
            display: none !important;
        }
    """
    html = html.replace('</style>', style_add + '\n</style>')

    # Write out
    with open(dest, 'w', encoding='utf-8') as f:
        f.write(html)

if __name__ == '__main__':
    main()
