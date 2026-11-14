INSERT INTO `order lines` (`id`, `name`, `note`, `price`, `ratio`, `active`, `meta`, `tags`, `path`) VALUES (1, 'Ñandú Pérez', 'plain', 10.5, 1, true, '{"2":{"z":false},"10":"ten","a":[1,2.5,null],"b":1}', '["x","y"]', 'C:\\temp\\file');
INSERT INTO `order lines` (`id`, `name`, `note`, `price`, `ratio`, `active`, `meta`, `tags`, `path`) VALUES (2, 'Zoë "quoted"', 'comma, here', -0.25, 1e+21, false, '{}', '[]', 'it''s');
INSERT INTO `order lines` (`id`, `name`, `note`, `price`, `ratio`, `active`, `meta`, `tags`, `path`) VALUES (3, 'semi;colon', 'line
break', 1e-7, 123456789012.75, true, '{"nested":{"deep":[{"k":"v"}]}}', '[1,[2,3]]', 'tab	here');
INSERT INTO `order lines` (`id`, `name`, `note`, `price`, `ratio`, `active`, `meta`, `tags`, `path`) VALUES (4, '', 'crlf
end', 100, 0.1, false, '{"quote":"say \\"hi\\""}', '["a,b","c;d"]', '\\\\server\\share');
