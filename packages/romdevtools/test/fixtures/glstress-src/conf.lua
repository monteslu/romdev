-- 1920x1080 ON PURPOSE: larger than the default playtest window, which is
-- what the corner-render and window-resize-clamp bugs both needed.
function love.conf(t)
  t.window.width = 1920
  t.window.height = 1080
end
