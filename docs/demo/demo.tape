# Records the README demo. Needs https://github.com/charmbracelet/vhs (brew install vhs).
#   vhs docs/demo/demo.tape
# Output: docs/demo/enforcement-loop.gif
Output docs/demo/enforcement-loop.gif
Set Shell "bash"
Set FontSize 13
Set Width 1280
Set Height 900
Set Padding 16
Set TypingSpeed 45ms
Set Theme "Dracula"

# Build first, off camera, so the recording shows only the demo.
Hide
Type "export PS1='$ ' && pnpm build >/dev/null && clear"
Enter
Sleep 20s
Show

Type "pnpm demo"
Sleep 600ms
Enter
Sleep 9s
Sleep 5s
